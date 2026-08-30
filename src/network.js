// network.js — signaling (WebSocket) + WebRTC P2P mesh (host <-> each guest).
import { ClockSynchronizer } from './sync-engine.js';

const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

// ---- Signaling client -------------------------------------------------------
export class SignalClient extends EventTarget {
  constructor(url, cfg) {
    super();
    this.url = url;
    this.cfg = cfg;
    this.ws = null;
    this.id = null;
    this.code = null;
    this.role = null;
    this.name = '';
    this.clock = new ClockSynchronizer(cfg);
    this._wantOpen = false;
    this._retryT = null;
    this._clockT = null;
    this._backoff = 500;
  }

  connect(code, role, name) {
    this.code = code; this.role = role; this.name = name || '';
    this._wantOpen = true;
    this._open();
  }

  _open() {
    const u = this.url + (this.url.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(this.code);
    let ws;
    try { ws = new WebSocket(u); } catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this._backoff = 500;
      this.send({ t: this.role === 'host' ? 'create' : 'join', name: this.name });
      this._startClock();
      this.dispatchEvent(new Event('ws-open'));
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      this._handle(m);
    };
    ws.onclose = () => {
      this._stopClock();
      this.dispatchEvent(new Event('ws-close'));
      if (this._wantOpen) this._scheduleRetry();
    };
    ws.onerror = () => {};
  }

  _scheduleRetry() {
    if (this._retryT) return;
    const wait = Math.min(this._backoff, 8000);
    this._backoff = Math.min(this._backoff * 2, 8000);
    this.dispatchEvent(new CustomEvent('reconnecting', { detail: { wait } }));
    this._retryT = setTimeout(() => { this._retryT = null; if (this._wantOpen) this._open(); }, wait);
  }

  _startClock() {
    this._stopClock();
    const ping = () => this.send({ t: 'time', t0: Date.now() });
    // Burst of rapid pings for a fast initial clock lock (calibration),
    // then settle into the steady-state cadence.
    let n = 0;
    const burst = this.cfg.clockBurstCount || 6;
    this._burstT = setInterval(() => {
      ping();
      if (++n >= burst) {
        clearInterval(this._burstT); this._burstT = null;
        this._clockT = setInterval(ping, this.cfg.clockSampleIntervalMs);
      }
    }, this.cfg.clockBurstIntervalMs || 220);
    ping();
  }
  _stopClock() {
    if (this._clockT) clearInterval(this._clockT);
    if (this._burstT) clearInterval(this._burstT);
    this._clockT = this._burstT = null;
  }

  _handle(m) {
    switch (m.t) {
      case 'created':
      case 'joined':
        this.id = m.id; this.role = m.role;
        this.dispatchEvent(new CustomEvent(m.t, { detail: m }));
        break;
      case 'time': {
        const t2 = Date.now();
        const q = this.clock.addSample(m.t0, m.t1, t2);
        this.dispatchEvent(new CustomEvent('clock', { detail: q }));
        break;
      }
      case 'peer-join':
      case 'peer-leave':
      case 'signal':
      case 'control':
      case 'host-left':
      case 'error':
        this.dispatchEvent(new CustomEvent(m.t, { detail: m }));
        break;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  signal(to, data) { this.send({ t: 'signal', to, data }); }
  control(data) { this.send({ t: 'control', data }); }

  close() {
    this._wantOpen = false;
    this._stopClock();
    if (this._retryT) { clearTimeout(this._retryT); this._retryT = null; }
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
  }
}

// ---- WebRTC peer (one per remote device) -----------------------------------
class Peer {
  constructor(mgr, remoteId, initiator) {
    this.mgr = mgr;
    this.id = remoteId;
    this.initiator = initiator;
    this.pc = new RTCPeerConnection({ iceServers: mgr.cfg.iceServers });
    this.dc = null;
    this.dcFast = null;
    this._recv = null; // { name, mime, size, received, chunks[] }
    this.connected = false;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) mgr.signal.signal(remoteId, { candidate: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      this.connected = st === 'connected';
      mgr.emit('peer-state', { id: remoteId, state: st });
      if (st === 'failed' || st === 'closed') mgr.remove(remoteId, st);
    };

    if (initiator) {
      this.dc = this.pc.createDataChannel('wavesync', { ordered: true });
      this._wireChannel();
      // Fast lane: unreliable + unordered, dedicated to timeline pings. A late
      // or dropped timeline update is worthless anyway (a fresher one is on
      // the way), so this trades reliability for the lowest possible latency
      // — no retransmit queueing, no head-of-line blocking behind file bytes.
      this.dcFast = this.pc.createDataChannel('wavesync-fast', { ordered: false, maxRetransmits: 0 });
      this._wireFastChannel();
      this.pc.createOffer()
        .then((o) => this.pc.setLocalDescription(o))
        .then(() => mgr.signal.signal(remoteId, { sdp: this.pc.localDescription }));
    } else {
      this.pc.ondatachannel = (e) => {
        if (e.channel.label === 'wavesync-fast') { this.dcFast = e.channel; this._wireFastChannel(); }
        else { this.dc = e.channel; this._wireChannel(); }
      };
    }
  }

  _wireFastChannel() {
    this.dcFast.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      this.mgr.emit('timeline', { id: this.id, data: msg });
    };
  }

  /** Send a timeline update over the fast lane. Silently no-ops if not open yet
   *  (the reliable relay path covers that gap — see app.js _broadcastTimeline). */
  sendTimeline(data) {
    if (this.dcFast && this.dcFast.readyState === 'open') {
      try { this.dcFast.send(JSON.stringify(data)); } catch (e) {}
    }
  }

  _wireChannel() {
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = 256 * 1024;
    this.dc.onopen = () => this.mgr.emit('dc-open', { id: this.id, peer: this });
    this.dc.onclose = () => this.mgr.emit('dc-close', { id: this.id });
    this.dc.onmessage = (e) => this._onData(e.data);
  }

  _onData(data) {
    if (typeof data === 'string') {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.kind === 'file-header') {
        this._recv = { name: msg.name, mime: msg.mime, size: msg.size, index: msg.index || 0, received: 0, chunks: [] };
        this.mgr.emit('file-start', { id: this.id, meta: msg });
      } else if (msg.kind === 'file-eof' && this._recv) {
        const blob = new Blob(this._recv.chunks, { type: this._recv.mime });
        const meta = { name: this._recv.name, mime: this._recv.mime, size: this._recv.size, index: this._recv.index };
        this._recv = null;
        blob.arrayBuffer().then((ab) => this.mgr.emit('file-done', { id: this.id, buffer: ab, meta }));
      }
      return;
    }
    // binary chunk
    if (this._recv) {
      this._recv.chunks.push(data);
      this._recv.received += data.byteLength;
      this.mgr.emit('file-progress', {
        id: this.id,
        index: this._recv.index,
        received: this._recv.received,
        size: this._recv.size,
        ratio: this._recv.size ? this._recv.received / this._recv.size : 0
      });
    }
  }

  async handleSignal(data) {
    if (data.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const ans = await this.pc.createAnswer();
        await this.pc.setLocalDescription(ans);
        this.mgr.signal.signal(this.id, { sdp: this.pc.localDescription });
      }
    } else if (data.candidate) {
      try { await this.pc.addIceCandidate(data.candidate); } catch (e) {}
    }
  }

  // Host: stream an ArrayBuffer over the datachannel with backpressure.
  async sendFile(arrayBuffer, meta) {
    if (!this.dc || this.dc.readyState !== 'open') return;
    const chunk = this.mgr.cfg.chunkSize;
    this.dc.send(JSON.stringify({ kind: 'file-header', name: meta.name, mime: meta.mime, size: arrayBuffer.byteLength, index: meta.index != null ? meta.index : 0 }));
    const view = new Uint8Array(arrayBuffer);
    for (let off = 0; off < view.byteLength; off += chunk) {
      if (this.dc.readyState !== 'open') return;
      if (this.dc.bufferedAmount > 4 * 1024 * 1024) await this._drain();
      this.dc.send(view.subarray(off, Math.min(off + chunk, view.byteLength)));
    }
    this.dc.send(JSON.stringify({ kind: 'file-eof' }));
  }

  _drain() {
    return new Promise((res) => {
      const h = () => { this.dc.removeEventListener('bufferedamountlow', h); res(); };
      this.dc.addEventListener('bufferedamountlow', h);
    });
  }

  close() { try { if (this.dc) this.dc.close(); } catch (e) {} try { if (this.dcFast) this.dcFast.close(); } catch (e) {} try { this.pc.close(); } catch (e) {} }
}

// ---- Peer manager -----------------------------------------------------------
export class PeerManager extends EventTarget {
  constructor(signal, cfg) {
    super();
    this.signal = signal;
    this.cfg = cfg;
    this.peers = new Map();

    signal.addEventListener('peer-join', (e) => {
      // host initiates a connection to each joining guest
      const id = e.detail.id;
      if (!this.peers.has(id)) this.peers.set(id, new Peer(this, id, true));
      this.emit('roster', {});
    });
    signal.addEventListener('peer-leave', (e) => this.remove(e.detail.id, 'left'));
    signal.addEventListener('signal', (e) => {
      const { from, data } = e.detail;
      let p = this.peers.get(from);
      if (!p) { p = new Peer(this, from, false); this.peers.set(from, p); }
      p.handleSignal(data);
    });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  remove(id, reason) {
    const p = this.peers.get(id);
    if (p) { p.close(); this.peers.delete(id); this.emit('roster', { removed: id, reason }); }
  }

  count() { return this.peers.size; }

  broadcastFile(arrayBuffer, meta) {
    for (const p of this.peers.values()) if (p.dc && p.dc.readyState === 'open') p.sendFile(arrayBuffer, meta);
  }

  /** Low-latency P2P path for timeline pings — sent alongside (not instead of)
   *  the signaling-relay control message, since the relay is the reliable
   *  fallback for peers whose fast channel isn't open yet. */
  broadcastTimeline(data) {
    for (const p of this.peers.values()) p.sendTimeline(data);
  }

  closeAll() { for (const p of this.peers.values()) p.close(); this.peers.clear(); }
}

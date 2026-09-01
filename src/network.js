// network.js — signaling (WebSocket) + WebRTC P2P mesh (host <-> each guest).
import { ClockSynchronizer, LatencyEstimator } from './sync-engine.js';

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
    this._tryWebTransport();
    this._open();
  }

  async _tryWebTransport() {
    if (typeof WebTransport === 'undefined') return;
    try {
      const wtUrl = this.url.replace(/^ws/, 'https') + '/wt?code=' + encodeURIComponent(this.code);
      this._wt = new WebTransport(wtUrl);
      await this._wt.ready;
      this._wtWriter = this._wt.datagrams.writable.getWriter();
      const reader = this._wt.datagrams.readable.getReader();
      (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          let m; try { m = JSON.parse(new TextDecoder().decode(value)); } catch { continue; }
          if (m && m.t === 'time' && typeof m.t0 === 'number' && typeof m.t1 === 'number') {
            const q = this.clock.addSample(m.t0, m.t1, Date.now(), 'webtransport');
            this.dispatchEvent(new CustomEvent('clock', { detail: q }));
          }
        }
      })();
    } catch (e) {
      this._wt = null; this._wtWriter = null;
    }
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
    // Deliberate design decision: reset the ClockSynchronizer's per-connection
    // bookkeeping (sample window, confidence, `synced` flag) on every connect
    // AND every reconnect, since a reconnect is a materially different network
    // path and stale confidence/sample-count shouldn't carry over. This does
    // NOT touch the Kalman offset/drift estimate itself (see
    // ClockSynchronizer.reset()'s own comment) — that's preserved so the
    // shared-clock estimate doesn't visibly jump, only its confidence is
    // re-earned. This also means 'sync' correctly refires once the next
    // burst re-locks, in case anything ever listens for it specifically.
    this.clock.reset();
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
    this.dc = null;       // reliable/ordered: control + file transfer
    this.dcFast = null;   // unreliable/unordered: latency ping/pong only
    this._recv = null; // { name, mime, size, received, chunks[] }
    this.connected = false;
    this.relay = null;    // true once we've confirmed the active ICE pair uses a TURN relay
    this._p2p = new LatencyEstimator();
    this._pingSeq = 0;
    this._pingT = null;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) mgr.signal.signal(remoteId, { candidate: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      this.connected = st === 'connected';
      mgr.emit('peer-state', { id: remoteId, state: st });
      if (st === 'connected') this._checkRelay();
      if (st === 'failed' || st === 'closed') mgr.remove(remoteId, st);
    };

    if (initiator) {
      this.dc = this.pc.createDataChannel('wavesync', { ordered: true });
      this._wireChannel();
      // Fast lane: unordered, no retransmits — a late/dropped latency ping is
      // worthless anyway, a fresher one is on the way (see H2 in the sync
      // engineering brief). Created before the offer so it's negotiated
      // in-band alongside the reliable channel, no renegotiation needed.
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

  _wireChannel() {
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = 256 * 1024;
    this.dc.onopen = () => this.mgr.emit('dc-open', { id: this.id, peer: this });
    this.dc.onclose = () => this.mgr.emit('dc-close', { id: this.id });
    this.dc.onmessage = (e) => this._onData(e.data);
  }

  // Lightweight ping/pong over the fast lane for real host<->guest P2P RTT
  // measurement (H2's second piece) — distinct from, and independently useful
  // from, ClockSynchronizer's signaling-WebSocket RTT. Symmetric by design:
  // whichever side sends 'ping' gets it echoed as 'pong' and computes RTT, so
  // both host and guest end up with live link-quality telemetry for this peer
  // (useful for a host wanting to see which guest has a flaky connection, not
  // just the guest sizing its own scheduling behavior).
  _wireFastChannel() {
    this.dcFast.binaryType = 'arraybuffer';
    this.dcFast.onopen = () => {
      const interval = this.mgr.cfg.p2pPingIntervalMs || 2000;
      this._pingT = setInterval(() => this._sendPing(), interval);
      this._sendPing();
    };
    this.dcFast.onclose = () => { if (this._pingT) { clearInterval(this._pingT); this._pingT = null; } };
    this.dcFast.onmessage = (e) => this._onFastData(e.data);
  }

  _sendPing() {
    if (!this.dcFast || this.dcFast.readyState !== 'open') return;
    try {
      this.dcFast.send(JSON.stringify({
        t: 'ping',
        seq: this._pingSeq++,
        perf0: performance.now(),
        t0: Date.now()
      }));
    } catch (e) {}
  }

  _onFastData(data) {
    if (typeof data !== 'string') return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'ping') {
      if (!this.dcFast || this.dcFast.readyState !== 'open') return;
      try {
        const remoteTime = (this.mgr && this.mgr.signal && this.mgr.signal.clock)
          ? this.mgr.signal.clock.now()
          : Date.now();
        this.dcFast.send(JSON.stringify({
          t: 'pong',
          seq: msg.seq,
          perf0: msg.perf0,
          t0: msg.t0,
          t1: remoteTime
        }));
      } catch (e) {}
    } else if (msg.t === 'pong') {
      const perfNow = performance.now();
      const wallNow = Date.now();
      const rttPerf = typeof msg.perf0 === 'number' ? perfNow - msg.perf0 : -1;
      if (rttPerf > 0 && isFinite(rttPerf)) {
        this._p2p.update(rttPerf);
        this.mgr.emit('p2p-latency', { id: this.id, rtt: this._p2p.oneWay * 2, jitter: this._p2p.jitter });
      }
      if (typeof msg.t0 === 'number' && typeof msg.t1 === 'number') {
        if (this.mgr && this.mgr.signal && this.mgr.signal.clock) {
          this.mgr.signal.clock.addSample(msg.t0, msg.t1, wallNow, 'webrtc');
        }
      }
    }
  }

  // Surface ICE relay/TURN fallback (§8.3): a peer on a TURN relay has
  // meaningfully different latency characteristics worth knowing about when
  // debugging a specific report. One-shot check shortly after connecting.
  async _checkRelay() {
    try {
      const stats = await this.pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r;
      });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const localType = local && local.candidateType;
      const remoteType = remote && remote.candidateType;
      this.relay = localType === 'relay' || remoteType === 'relay';
      this.mgr.emit('peer-relay', { id: this.id, relay: this.relay, localType, remoteType });
    } catch (e) {}
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

  close() {
    if (this._pingT) { clearInterval(this._pingT); this._pingT = null; }
    try { if (this.dc) this.dc.close(); } catch (e) {}
    try { if (this.dcFast) this.dcFast.close(); } catch (e) {}
    try { this.pc.close(); } catch (e) {}
  }
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

  closeAll() { for (const p of this.peers.values()) p.close(); this.peers.clear(); }
}

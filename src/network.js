// Signaling and host-to-guest WebRTC networking.
import { ClockSynchronizer, LatencyEstimator } from './sync-engine.js';
import { DataChannelTransfer } from './transfer.js';
import {
  LIMITS,
  isObject,
  validSignal,
  validTimeline,
  validTrack
} from '../shared/protocol.js';

const MAX_SIGNAL_BYTES = LIMITS.signalBytes;
const MAX_ENCODED_BYTES = LIMITS.maxEncodedBytes;
const MAX_GUESTS = LIMITS.maxGuests;
const MAX_TRACKS = LIMITS.maxTracks;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max;

function detailEvent(type, detail) {
  if (typeof CustomEvent === 'function') return new CustomEvent(type, { detail });
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail, enumerable: true });
  return event;
}

function jsonBytes(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return Infinity; }
}

function validPeer(peer) {
  return isObject(peer) && text(peer.id, 256)
    && (peer.role === 'host' || peer.role === 'guest')
    && (peer.name == null || typeof peer.name === 'string')
    && (peer.online == null || typeof peer.online === 'boolean');
}

function validRoomDetail(message) {
  if (!text(message.id, 256) || !text(message.token, 2048)
      || (message.role !== 'host' && message.role !== 'guest')) return false;
  if (message.peers != null && (!Array.isArray(message.peers)
      || message.peers.length > MAX_GUESTS + 1 || !message.peers.every(validPeer))) return false;
  if (message.host != null && !text(message.host, 256)
      && !(validPeer(message.host) && message.host.role === 'host')) return false;
  if (message.track != null && !validTrack(message.track)) return false;
  if (message.timeline != null && !validTimeline(message.timeline, null)) return false;
  return message.epoch == null || text(message.epoch, 256) || finite(message.epoch);
}

/** Resumable signaling client. Identity and resume token are kept in memory only. */
export class SignalClient extends EventTarget {
  constructor(url, cfg = {}) {
    super();
    this.url = url;
    this.cfg = cfg;
    this.clock = cfg.clock && typeof cfg.clock.addSample === 'function'
      ? cfg.clock
      : new ClockSynchronizer(cfg.clock || cfg);
    this.ws = null;
    this.id = null;
    this.token = null;
    this.code = null;
    this.role = null;
    this.name = '';
    this.registered = false;
    this._wanted = false;
    this._generation = 0;
    this._retryTimer = null;
    this._registerTimer = null;
    this._clockTimer = null;
    this._burstTimer = null;
    this._probes = new Map();
    this._backoff = cfg.reconnectBaseMs || 500;
  }

  connect(code, role, name = '') {
    const sameSession = this.code === code && this.role === role;
    if (this._wanted) this.close();
    if (!sameSession) {
      this.id = null;
      this.token = null;
    }
    this.code = code;
    this.role = role;
    this.name = typeof name === 'string' ? name : '';
    this._wanted = true;
    this._backoff = this.cfg.reconnectBaseMs || 500;
    this._open();
  }

  reconnect() {
    if (!this._wanted) return;
    this._clearSocket(false);
    this._scheduleRetry(0);
  }

  _open() {
    if (!this._wanted) return;
    const generation = ++this._generation;
    const WebSocketClass = this.cfg.WebSocket || globalThis.WebSocket;
    if (!WebSocketClass) {
      this._emitError('WebSocket is unavailable');
      this._scheduleRetry();
      return;
    }
    const separator = this.url.includes('?') ? '&' : '?';
    let socket;
    try { socket = new WebSocketClass(`${this.url}${separator}code=${encodeURIComponent(this.code)}`); }
    catch {
      this._scheduleRetry();
      return;
    }
    this.ws = socket;
    try { socket.binaryType = 'arraybuffer'; } catch {}

    socket.onopen = () => {
      if (!this._current(generation, socket)) return;
      this.registered = false;
      const registration = { t: this.role === 'host' ? 'create' : 'join', name: this.name };
      if (this.id && this.token) Object.assign(registration, { id: this.id, token: this.token });
      if (!this.send(registration)) {
        this._emitError('Could not send signaling registration');
        try { socket.close(); } catch {}
        return;
      }
      this._registerTimer = setTimeout(() => {
        if (!this._current(generation, socket) || this.registered) return;
        this._emitError('Signaling registration timed out');
        try { socket.close(); } catch {}
      }, this.cfg.registrationTimeoutMs || 8_000);
      this.dispatchEvent(new Event('ws-open'));
    };
    socket.onmessage = (event) => {
      if (!this._current(generation, socket) || typeof event.data !== 'string'
          || jsonBytes(event.data) > MAX_SIGNAL_BYTES) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      this._handle(message);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (!this._current(generation, socket)) return;
      this.ws = null;
      this.registered = false;
      this._clearConnectionTimers();
      this.dispatchEvent(new Event('ws-close'));
      if (this._wanted) this._scheduleRetry();
    };
  }

  _current(generation, socket) {
    return generation === this._generation && socket === this.ws;
  }

  _registration(message) {
    if (!validRoomDetail(message) || message.role !== this.role) return;
    this.id = message.id;
    this.token = message.token;
    this.role = message.role;
    this.registered = true;
    clearTimeout(this._registerTimer);
    this._registerTimer = null;
    this._backoff = this.cfg.reconnectBaseMs || 500;
    this._startClock();
    this.dispatchEvent(detailEvent(message.t, {
      id: message.id,
      role: message.role,
      host: message.host,
      epoch: message.epoch,
      token: message.token,
      peers: message.peers || [],
      track: message.track ?? null,
      timeline: message.timeline ?? null,
      ...(message.code != null ? { code: message.code } : {})
    }));
  }

  _handle(message) {
    if (!isObject(message) || typeof message.t !== 'string') return;
    switch (message.t) {
      case 'created':
      case 'joined':
        this._registration(message);
        return;
      case 'time':
        this._handleTime(message);
        return;
      case 'peer-join':
        if (!validPeer({ id: message.id, role: message.role || 'guest', name: message.name || '' })) return;
        break;
      case 'peer-leave':
        if (!text(message.id, 256)) return;
        break;
      case 'roster':
        if (!Array.isArray(message.peers) || message.peers.length > MAX_GUESTS + 1
            || !message.peers.every(validPeer)) return;
        break;
      case 'host-left':
      case 'host-restored':
        if (message.id != null && !text(message.id, 256)) return;
        break;
      case 'signal':
        if (!text(message.from, 256) || !validSignal(message.data)
            || jsonBytes(message.data) > MAX_SIGNAL_BYTES) return;
        break;
      case 'control':
        if (!isObject(message.data) || jsonBytes(message.data) > MAX_SIGNAL_BYTES) return;
        if (message.data.kind === 'timeline' && !validTimeline(message.data, null)) return;
        if (message.data.kind === 'track' && !validTrack(message.data)) return;
        break;
      case 'error':
        if (message.msg != null && typeof message.msg !== 'string') return;
        if (!this.registered && /resume credentials|room has ended/i.test(message.msg || '')) {
          // A runtime restart/expired room cannot resume old identity. Require deliberate re-entry.
          this._wanted = false;
          this._clearSocket(false);
          message = { ...message, fatal: true, msg: `${message.msg}. Leave and create or join a fresh room.` };
        }
        break;
      default:
        return;
    }
    this.dispatchEvent(detailEvent(message.t, message));
  }

  _performanceNow() {
    return (this.cfg.performance || globalThis.performance).now();
  }

  _probe() {
    if (!this.registered) return;
    const t0 = this._performanceNow();
    const key = String(t0);
    this._probes.set(key, { t0 });
    while (this._probes.size > 32) this._probes.delete(this._probes.keys().next().value);
    if (!this.send({ t: 'time', t0 })) this._probes.delete(key);
  }

  _handleTime(message) {
    if (!finite(message.t0) || !finite(message.t1)) return;
    const probe = this._probes.get(String(message.t0));
    if (!probe) return;
    this._probes.delete(String(message.t0));
    const t2 = this._performanceNow();
    const quality = this.clock.addSample(probe.t0, message.t1, t2, finite(message.t3) ? message.t3 : message.t1);
    const snapshot = quality ?? (typeof this.clock.quality === 'function' ? this.clock.quality() : this.clock.quality);
    this.dispatchEvent(detailEvent('clock', snapshot));
  }

  _startClock() {
    this._stopClock();
    this.clock.reset();
    this._probe();
    let count = 1;
    const burstCount = this.cfg.clockBurstCount || 6;
    const steady = () => { this._clockTimer = setInterval(() => this._probe(), this.cfg.clockSampleIntervalMs || 2_000); };
    if (count >= burstCount) { steady(); return; }
    this._burstTimer = setInterval(() => {
      this._probe();
      if (++count >= burstCount) {
        clearInterval(this._burstTimer);
        this._burstTimer = null;
        steady();
      }
    }, this.cfg.clockBurstIntervalMs || 220);
  }

  _stopClock() {
    clearInterval(this._clockTimer);
    clearInterval(this._burstTimer);
    this._clockTimer = this._burstTimer = null;
    this._probes.clear();
  }

  _scheduleRetry(forcedWait) {
    if (!this._wanted || this._retryTimer) return;
    const cap = this.cfg.reconnectMaxMs || 8_000;
    const base = forcedWait ?? Math.min(this._backoff, cap);
    const random = this.cfg.random || Math.random;
    const wait = forcedWait ?? Math.round(base * (0.75 + random() * 0.5));
    if (forcedWait == null) this._backoff = Math.min(this._backoff * 2, cap);
    this.dispatchEvent(detailEvent('reconnecting', { wait }));
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._open();
    }, wait);
  }

  send(object) {
    const Open = (this.cfg.WebSocket || globalThis.WebSocket)?.OPEN ?? 1;
    if (!this.ws || this.ws.readyState !== Open || !isObject(object)
        || jsonBytes(object) > MAX_SIGNAL_BYTES) return false;
    try { this.ws.send(JSON.stringify(object)); return true; } catch { return false; }
  }

  signal(to, data) {
    return text(to, 256) && validSignal(data) && this.send({ t: 'signal', to, data });
  }

  control(data) {
    return isObject(data) && this.send({ t: 'control', data });
  }

  _emitError(msg) {
    this.dispatchEvent(detailEvent('error', { t: 'error', msg }));
  }

  _clearConnectionTimers() {
    clearTimeout(this._registerTimer);
    this._registerTimer = null;
    this._stopClock();
  }

  _clearSocket(close = true) {
    ++this._generation;
    const socket = this.ws;
    this.ws = null;
    this.registered = false;
    this._clearConnectionTimers();
    if (close) { try { socket?.close(); } catch {} }
    else { try { socket?.close(); } catch {} }
  }

  close() {
    this._wanted = false;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._clearSocket();
  }
}

class Peer {
  constructor(manager, id, initiator, generation) {
    this.manager = manager;
    this.id = id;
    this.initiator = initiator;
    this.generation = generation;
    this.connected = false;
    this.relay = null;
    this.dc = null;
    this.dcFast = null;
    this.transfer = null;
    this._closed = false;
    this._remoteSet = false;
    this._iceQueue = [];
    this._signalChain = Promise.resolve();
    this._pingSequence = 0;
    this._pings = new Map();
    this._pingTimer = null;
    this._disconnectTimer = null;
    this._latency = new LatencyEstimator();
    const PeerConnection = manager.cfg.RTCPeerConnection || globalThis.RTCPeerConnection;
    this.pc = new PeerConnection({ iceServers: manager.cfg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] });
    this._wireConnection();
    if (initiator) {
      this._acceptChannel(this.pc.createDataChannel('wavesync', { ordered: true }));
      this._acceptFastChannel(this.pc.createDataChannel('wavesync-fast', { ordered: false, maxRetransmits: 0 }));
      void this._negotiate();
    } else {
      this.pc.ondatachannel = (event) => {
        if (!this._live()) { try { event.channel.close(); } catch {} return; }
        if (event.channel.label === 'wavesync-fast') this._acceptFastChannel(event.channel);
        else if (event.channel.label === 'wavesync') this._acceptChannel(event.channel);
        else try { event.channel.close(); } catch {}
      };
    }
  }

  _live() {
    return !this._closed && this.manager.peers.get(this.id) === this
      && this.manager._generations.get(this.id) === this.generation;
  }

  _wireConnection() {
    this.pc.onicecandidate = (event) => {
      if (this._live() && event.candidate) this.manager.signal.signal(this.id, { candidate: event.candidate.toJSON?.() || event.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      if (!this._live()) return;
      const state = this.pc.connectionState;
      this.connected = state === 'connected';
      this.manager.emit('peer-state', { id: this.id, state });
      if (state === 'connected') {
        clearTimeout(this._disconnectTimer);
        this._repairAttempt = 0;
        const repair = this.manager._repairs.get(this.id);
        if (repair) clearTimeout(repair.timer);
        this.manager._repairs.delete(this.id);
        void this._checkRelay();
      } else if (state === 'failed') {
        this.manager._scheduleRepair(this.id);
      } else if (state === 'disconnected') {
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = setTimeout(() => this._live() && this.manager._scheduleRepair(this.id), this.manager.cfg.disconnectGraceMs || 3_000);
      } else if (state === 'closed') {
        this.manager.remove(this.id, state);
      }
    };
  }

  async _negotiate() {
    try {
      const offer = await this.pc.createOffer();
      if (!this._live()) return;
      await this.pc.setLocalDescription(offer);
      if (this._live()) this.manager.signal.signal(this.id, { sdp: this.pc.localDescription });
    } catch (error) { this._fail(error); }
  }

  _acceptChannel(channel) {
    if (this.dc && this.dc !== channel) { try { channel.close(); } catch {} return; }
    this.dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (!this._live() || this.dc !== channel) return;
      this.transfer?.close(new Error('Data channel replaced'));
      this.transfer = new DataChannelTransfer(channel, this.manager.cfg);
      for (const type of ['file-start', 'file-progress', 'file-done', 'transfer-error']) {
        this.transfer.addEventListener(type, (event) => this._live() && this.manager.emit(type, { id: this.id, ...event.detail }));
      }
      this.manager.emit('dc-open', { id: this.id, peer: this });
    };
    channel.onclose = () => {
      if (this.dc !== channel) return;
      this.transfer?.close(new Error('Data channel closed'));
      this.transfer = null;
      this.dc = null;
      if (this._live()) this.manager.emit('dc-close', { id: this.id });
    };
    channel.onerror = () => {
      if (this.dc === channel) this.transfer?.close(new Error('Data channel error'));
    };
  }

  _acceptFastChannel(channel) {
    if (this.dcFast && this.dcFast !== channel) { try { channel.close(); } catch {} return; }
    this.dcFast = channel;
    channel.onopen = () => {
      if (!this._live() || this.dcFast !== channel) return;
      clearInterval(this._pingTimer);
      this._sendPing();
      this._pingTimer = setInterval(() => this._sendPing(), this.manager.cfg.p2pPingIntervalMs || 2_000);
    };
    channel.onmessage = (event) => {
      if (this.dcFast === channel) this._onFastData(event.data);
    };
    channel.onclose = () => {
      if (this.dcFast !== channel) return;
      clearInterval(this._pingTimer);
      this._pingTimer = null;
      this.dcFast = null;
      this._pings.clear();
    };
  }

  _sendPing() {
    if (!this._live() || this.dcFast?.readyState !== 'open') return;
    const seq = this._pingSequence++;
    const now = performance.now();
    this._pings.set(seq, now);
    while (this._pings.size > 16) this._pings.delete(this._pings.keys().next().value);
    try { this.dcFast.send(JSON.stringify({ t: 'ping', seq })); } catch { this._pings.delete(seq); }
  }

  _onFastData(data) {
    if (!this._live() || typeof data !== 'string' || data.length > 1024) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (!isObject(message) || !Number.isSafeInteger(message.seq) || message.seq < 0) return;
    if (message.t === 'ping' && this.dcFast?.readyState === 'open') {
      try { this.dcFast.send(JSON.stringify({ t: 'pong', seq: message.seq })); } catch {}
    } else if (message.t === 'pong') {
      const sent = this._pings.get(message.seq);
      if (sent == null) return;
      this._pings.delete(message.seq);
      const rtt = performance.now() - sent;
      if (!finite(rtt) || rtt < 0) return;
      this._latency.update(rtt);
      const sample = { id: this.id, rtt: this._latency.oneWay * 2, jitter: this._latency.jitter };
      this.manager.cfg.networkQuality?.peerSample?.(sample);
      this.manager.emit('p2p-latency', sample);
    }
  }

  handleSignal(data) {
    this._signalChain = this._signalChain.then(async () => {
      if (!this._live() || !validSignal(data)) return;
      if (data.sdp) {
        await this.pc.setRemoteDescription(data.sdp);
        this._remoteSet = true;
        for (const candidate of this._iceQueue.splice(0)) await this.pc.addIceCandidate(candidate);
        if (data.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          if (!this._live()) return;
          await this.pc.setLocalDescription(answer);
          if (this._live()) this.manager.signal.signal(this.id, { sdp: this.pc.localDescription });
        }
      } else if (this._remoteSet) {
        await this.pc.addIceCandidate(data.candidate);
      } else {
        this._iceQueue.push(data.candidate);
        if (this._iceQueue.length > 256) throw new Error('Too many queued ICE candidates');
      }
    }).catch((error) => this._fail(error));
    return this._signalChain;
  }

  sendFile(arrayBuffer, meta) {
    if (!this.transfer || this.dc?.readyState !== 'open') return Promise.reject(new Error('Peer data channel is not open'));
    return this.transfer.sendFile(arrayBuffer, meta);
  }

  async _checkRelay() {
    try {
      const stats = await this.pc.getStats();
      if (!this._live()) return;
      let pair;
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || !pair)) pair = report;
      });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const localType = local?.candidateType;
      const remoteType = remote?.candidateType;
      this.relay = localType === 'relay' || remoteType === 'relay';
      this.manager.emit('peer-relay', { id: this.id, relay: this.relay, localType, remoteType });
    } catch {}
  }

  _fail(error) {
    if (!this._live()) return;
    this.manager.emit('transfer-error', { id: this.id, message: error?.message || 'Peer negotiation failed' });
    this.manager._scheduleRepair(this.id);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._pingTimer);
    clearTimeout(this._disconnectTimer);
    this._pings.clear();
    this.transfer?.close(new Error('Peer closed'));
    this.transfer = null;
    try { this.dc?.close(); } catch {}
    try { this.dcFast?.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ondatachannel = null;
  }
}

/** Maintains the permitted host/guest star topology and peer repair lifecycle. */
export class PeerManager extends EventTarget {
  constructor(signal, cfg = {}) {
    super();
    this.signal = signal;
    this.cfg = cfg;
    this.peers = new Map();
    this._known = new Map();
    this._generations = new Map();
    this._repairs = new Map();
    this._listeners = [];
    this._destroyed = false;
    this._listen('created', (event) => this._rebuild(event.detail));
    this._listen('joined', (event) => this._rebuild(event.detail));
    this._listen('roster', (event) => this._applyRoster(event.detail.peers || []));
    this._listen('peer-join', (event) => this._peerJoined(event.detail));
    this._listen('peer-leave', (event) => this._peerLeft(event.detail));
    this._listen('host-left', () => this._hostLeft());
    this._listen('host-restored', (event) => this._hostRestored(event.detail));
    this._listen('signal', (event) => this._onSignal(event.detail));
  }

  _listen(type, handler) {
    this.signal.addEventListener(type, handler);
    this._listeners.push(() => this.signal.removeEventListener(type, handler));
  }

  emit(type, detail) { this.dispatchEvent(detailEvent(type, detail)); }

  _role() { return this.signal.role; }

  _rebuild(detail) {
    const peers = detail.peers || [];
    let host = null;
    // A welcome is the boundary of a signaling generation. The host will make
    // fresh offers, so neither role may retain old PCs/channels that can reject
    // or race their replacements.
    this.closeAll();
    if (this._role() === 'guest') {
      host = (isObject(detail.host) ? detail.host : null)
        || peers.find((peer) => peer.role === 'host' && peer.id === detail.host)
        || peers.find((peer) => peer.role === 'host')
        || (typeof detail.host === 'string' ? { id: detail.host, role: 'host', name: 'Host' } : null);
    }
    this._applyRoster(peers);
    if (host?.id && host.online !== false && !this._known.has(host.id)) {
      this._known.set(host.id, { ...host, role: 'host' });
      this.emit('roster', { peers: [...this._known.values()] });
    }
  }

  _applyRoster(peers) {
    const allowed = new Map();
    for (const peer of peers) {
      if (!validPeer(peer) || peer.id === this.signal.id || peer.online === false) continue;
      if (this._role() === 'host' ? peer.role === 'guest' : peer.role === 'host') allowed.set(peer.id, peer);
    }
    if (this._role() === 'guest' && allowed.size > 1) {
      const first = allowed.entries().next().value;
      allowed.clear();
      if (first) allowed.set(...first);
    }
    this._known = allowed;
    for (const id of [...this.peers.keys()]) if (!allowed.has(id)) this.remove(id, 'roster');
    if (this._role() === 'host') for (const id of allowed.keys()) this._ensure(id, true);
    this.emit('roster', { peers: [...allowed.values()] });
  }

  _peerJoined(detail) {
    const peer = { id: detail.id, role: detail.role || 'guest', name: detail.name || '' };
    if (!validPeer(peer) || this._role() !== 'host' || peer.role !== 'guest') return;
    this._known.set(peer.id, peer);
    this._ensure(peer.id, true);
    this.emit('roster', { peers: [...this._known.values()] });
  }

  _peerLeft(detail) {
    this._known.delete(detail.id);
    this.remove(detail.id, 'left');
  }

  _hostLeft() {
    if (this._role() !== 'guest') return;
    for (const id of [...this.peers.keys()]) this.remove(id, 'host-left');
    this._known.clear();
  }

  _hostRestored(detail) {
    if (this._role() !== 'guest') return;
    const host = isObject(detail.host) ? detail.host
      : text(detail.id, 256) ? { id: detail.id, role: 'host', name: 'Host' } : null;
    if (host && validPeer({ ...host, role: 'host' })) {
      this._known.clear();
      this._known.set(host.id, { ...host, role: 'host' });
    }
    this.signal.reconnect();
  }

  _permitted(id) {
    const peer = this._known.get(id);
    return !!peer && (this._role() === 'host' ? peer.role === 'guest' : peer.role === 'host');
  }

  _ensure(id, initiator) {
    if (this._destroyed || !this._permitted(id)) return null;
    let peer = this.peers.get(id);
    if (peer) return peer;
    const generation = (this._generations.get(id) || 0) + 1;
    this._generations.set(id, generation);
    try {
      peer = new Peer(this, id, initiator, generation);
      this.peers.set(id, peer);
      return peer;
    } catch (error) {
      this.emit('transfer-error', { id, message: error?.message || 'Could not create peer connection' });
      return null;
    }
  }

  _onSignal({ from, data }) {
    if (!this._permitted(from)) return;
    let peer = this.peers.get(from);
    if (!peer) {
      if (this._role() === 'host' && data.sdp?.type === 'offer') return;
      peer = this._ensure(from, false);
    }
    peer?.handleSignal(data);
  }

  _scheduleRepair(id) {
    if (this._destroyed || !this._permitted(id) || this._repairs.has(id)) return;
    const attempt = this.peers.get(id)?._repairAttempt || 0;
    const delay = Math.min((this.cfg.peerRepairBaseMs || 500) * (2 ** attempt), this.cfg.peerRepairMaxMs || 8_000);
    const timer = setTimeout(() => {
      this._repairs.delete(id);
      const old = this.peers.get(id);
      if (old) old._repairAttempt = attempt + 1;
      this.remove(id, 'repair');
      const replacement = this._role() === 'host' ? this._ensure(id, true) : null;
      if (replacement) replacement._repairAttempt = attempt + 1;
      else if (this._role() !== 'host') this.signal.reconnect();
    }, delay);
    this._repairs.set(id, { timer, attempt: attempt + 1 });
  }

  reconnect(id) {
    if (id) {
      if (!this._permitted(id)) return false;
      this.remove(id, 'manual-repair');
      if (this._role() === 'host') this._ensure(id, true);
      else this.signal.reconnect();
      return true;
    }
    for (const peerId of [...this.peers.keys()]) this.remove(peerId, 'manual-repair');
    if (this._role() === 'host') for (const peerId of this._known.keys()) this._ensure(peerId, true);
    else this.signal.reconnect();
    return true;
  }

  remove(id, reason = 'removed') {
    const repair = this._repairs.get(id);
    if (repair) clearTimeout(repair.timer);
    this._repairs.delete(id);
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this._generations.set(id, (this._generations.get(id) || 0) + 1);
    peer.close();
    this.emit('roster', { removed: id, reason, peers: [...this._known.values()] });
  }

  count() { return this.peers.size; }

  broadcastFile(arrayBuffer, meta) {
    const jobs = [];
    for (const peer of this.peers.values()) jobs.push(peer.sendFile(arrayBuffer, meta));
    return Promise.allSettled(jobs);
  }

  closeAll() {
    for (const repair of this._repairs.values()) clearTimeout(repair.timer);
    this._repairs.clear();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.closeAll();
    for (const remove of this._listeners.splice(0)) remove();
    this._known.clear();
  }
}

export const NETWORK_LIMITS = Object.freeze({
  maxEncodedBytes: MAX_ENCODED_BYTES,
  signalBytes: MAX_SIGNAL_BYTES,
  maxGuests: MAX_GUESTS,
  maxTracks: MAX_TRACKS
});

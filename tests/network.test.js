import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalClient, PeerManager } from '../src/network.js';

class FakeClock {
  constructor() { this.synced = false; this.samples = []; this.resets = 0; }
  reset() { this.resets++; this.synced = false; }
  addSample(...sample) { this.samples.push(sample); this.synced = true; return this.quality(); }
  now() { return Date.now(); }
  quality() { return { synced: this.synced, samples: this.samples.length }; }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(value) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}

class FakeSignal extends EventTarget {
  constructor(role, id = role) { super(); this.role = role; this.id = id; this.sent = []; this.reconnects = 0; }
  signal(to, data) { this.sent.push({ to, data }); return true; }
  reconnect() { this.reconnects++; }
  emit(type, detail) {
    const event = new Event(type);
    Object.defineProperty(event, 'detail', { value: detail });
    this.dispatchEvent(event);
  }
}

class FakeDataChannel extends EventTarget {
  constructor(label) { super(); this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0; }
  send() {}
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}

class FakePeerConnection {
  static instances = [];
  constructor() {
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.channels = [];
    this.candidates = [];
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }
  createDataChannel(label) { const channel = new FakeDataChannel(label); this.channels.push(channel); return channel; }
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate(value) { this.candidates.push(value); }
  async getStats() { return new Map(); }
  close() { this.closed = true; this.connectionState = 'closed'; }
}

const registration = (t = 'joined') => ({
  t, id: t === 'created' ? 'host' : 'guest', role: t === 'created' ? 'host' : 'guest',
  token: 'private-resume-token', epoch: 'epoch-1', peers: [], track: null, timeline: null
});

function wsCfg(extra = {}) {
  let monotonic = 100;
  return {
    WebSocket: FakeWebSocket,
    clock: {},
    performance: { now: () => monotonic += 10 },
    clockBurstCount: 1,
    clockSampleIntervalMs: 60_000,
    registrationTimeoutMs: 1_000,
    random: () => 0.5,
    reconnectBaseMs: 1,
    reconnectMaxMs: 2,
    ...extra
  };
}

test('SignalClient resumes with in-memory id/token and only resets backoff after registration', async () => {
  FakeWebSocket.instances.length = 0;
  const client = new SignalClient('ws://example.test/api', wsCfg());
  client.clock = new FakeClock();
  client.connect('ABCD', 'guest', 'Alice');
  const first = FakeWebSocket.instances[0];
  first.open();
  assert.deepEqual(first.sent[0], { t: 'join', name: 'Alice' });
  first.receive(registration());
  assert.equal(client.id, 'guest');
  assert.equal(client.token, 'private-resume-token');
  assert.equal(client.clock.resets, 1);

  first.close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = FakeWebSocket.instances[1];
  second.open();
  assert.deepEqual(second.sent[0], { t: 'join', name: 'Alice', id: 'guest', token: 'private-resume-token' });
  client.close();
});

test('expired resume credentials stop automatic retry and emit deliberate recovery error', async () => {
  FakeWebSocket.instances.length = 0;
  const client = new SignalClient('ws://example.test/api', wsCfg());
  client.connect('ABCDEF','guest','Guest');
  const first = FakeWebSocket.instances[0];first.open();first.receive(registration());
  first.close();await new Promise(resolve => setTimeout(resolve,5));
  const second = FakeWebSocket.instances[1];second.open();
  let failure;client.addEventListener('error',event=>failure=event.detail);
  second.receive({t:'error',msg:'Invalid or expired resume credentials'});
  assert.equal(client._wanted,false);
  assert.equal(failure.fatal,true);
  assert.match(failure.msg,/fresh room/);
  client.close();
});

test('clock accepts only matched probes and passes monotonic client timestamps', () => {
  FakeWebSocket.instances.length = 0;
  const client = new SignalClient('ws://example.test/api', wsCfg());
  client.clock = new FakeClock();
  client.connect('ABCD', 'guest', 'Alice');
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive(registration());
  const probe = socket.sent.find((message) => message.t === 'time');
  assert.ok(probe);
  socket.receive({ t: 'time', t0: probe.t0 + 1, t1: Date.now() });
  assert.equal(client.clock.samples.length, 0);
  socket.receive({ t: 'time', t0: probe.t0, t1: Date.now(), t3: Date.now() });
  assert.equal(client.clock.samples.length, 1);
  assert.equal(client.clock.samples[0][0], probe.t0);
  assert.ok(client.clock.samples[0][2] >= client.clock.samples[0][0]);
  client.close();
});

test('malformed, binary, oversized, and invalid protocol events are ignored', () => {
  FakeWebSocket.instances.length = 0;
  const client = new SignalClient('ws://example.test/api', wsCfg());
  client.connect('ABCD', 'guest', 'Alice');
  const socket = FakeWebSocket.instances[0];
  socket.open();
  let signals = 0;
  client.addEventListener('signal', () => signals++);
  socket.receive('{');
  socket.onmessage({ data: new ArrayBuffer(8) });
  socket.receive({ t: 'signal', from: 'host', data: { arbitrary: true } });
  socket.receive(JSON.stringify({ t: 'signal', from: 'host', data: { sdp: { type: 'offer', sdp: 'x'.repeat(70_000) } } }));
  assert.equal(signals, 0);
  client.close();
});

test('stale socket callbacks cannot affect a newer generation', () => {
  FakeWebSocket.instances.length = 0;
  const client = new SignalClient('ws://example.test/api', wsCfg());
  client.connect('ABCD', 'guest', 'Alice');
  const stale = FakeWebSocket.instances[0];
  const staleOpen = stale.onopen;
  client.reconnect();
  staleOpen();
  assert.equal(stale.sent.length, 0);
  client.close();
});

test('host creates peers only for known guests and guest rejects guest-to-guest signaling', async () => {
  FakePeerConnection.instances.length = 0;
  const hostSignal = new FakeSignal('host', 'host');
  const host = new PeerManager(hostSignal, { RTCPeerConnection: FakePeerConnection });
  hostSignal.emit('created', { peers: [{ id: 'g1', role: 'guest', name: 'One' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.count(), 1);
  assert.equal(hostSignal.sent[0].to, 'g1');
  hostSignal.emit('signal', { from: 'stranger', data: { sdp: { type: 'answer', sdp: 'bad' } } });
  assert.equal(host.count(), 1);

  const guestSignal = new FakeSignal('guest', 'g1');
  const guest = new PeerManager(guestSignal, { RTCPeerConnection: FakePeerConnection });
  guestSignal.emit('joined', { host: { id: 'host', role: 'host', name: 'Host' }, peers: [
    { id: 'host', role: 'host', name: 'Host' }, { id: 'g2', role: 'guest', name: 'Two' }
  ] });
  guestSignal.emit('signal', { from: 'g2', data: { sdp: { type: 'offer', sdp: 'guest offer' } } });
  assert.equal(guest.count(), 0);
  guestSignal.emit('signal', { from: 'host', data: { sdp: { type: 'offer', sdp: 'host offer' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guest.count(), 1);
  assert.equal(guestSignal.sent[0].to, 'host');
  host.destroy(); guest.destroy();
});

test('guest welcome replaces an old host peer before accepting fresh offer channels', async () => {
  FakePeerConnection.instances.length = 0;
  const signal = new FakeSignal('guest', 'g1');
  const manager = new PeerManager(signal, { RTCPeerConnection: FakePeerConnection });
  const welcome = { host: 'host', peers: [{ id: 'host', role: 'host', name: 'Host', online: true }] };
  signal.emit('joined', welcome);
  signal.emit('signal', { from: 'host', data: { sdp: { type: 'offer', sdp: 'first' } } });
  await new Promise((resolve) => setImmediate(resolve));
  const first = manager.peers.get('host');
  const firstPc = first.pc;
  const firstChannel = new FakeDataChannel('wavesync');
  first.pc.ondatachannel({ channel: firstChannel });
  assert.equal(first.dc, firstChannel);

  signal.emit('joined', welcome);
  assert.equal(firstPc.closed, true);
  assert.equal(manager.count(), 0);
  signal.emit('signal', { from: 'host', data: { sdp: { type: 'offer', sdp: 'second' } } });
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = manager.peers.get('host');
  assert.notEqual(replacement, first);
  const replacementChannel = new FakeDataChannel('wavesync');
  replacement.pc.ondatachannel({ channel: replacementChannel });
  assert.equal(replacement.dc, replacementChannel);
  assert.notEqual(replacementChannel.readyState, 'closed');
  manager.destroy();
});

test('ICE candidates queue until remote description and teardown removes listeners', async () => {
  FakePeerConnection.instances.length = 0;
  const signal = new FakeSignal('guest', 'g1');
  const manager = new PeerManager(signal, { RTCPeerConnection: FakePeerConnection });
  signal.emit('joined', { host: { id: 'host', role: 'host', name: 'Host' }, peers: [{ id: 'host', role: 'host', name: 'Host' }] });
  signal.emit('signal', { from: 'host', data: { candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } } });
  const pc = FakePeerConnection.instances[0];
  assert.equal(pc.candidates.length, 0);
  signal.emit('signal', { from: 'host', data: { sdp: { type: 'offer', sdp: 'offer' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pc.candidates.length, 1);
  manager.destroy();
  assert.equal(pc.closed, true);
  signal.emit('signal', { from: 'host', data: { sdp: { type: 'offer', sdp: 'late' } } });
  assert.equal(manager.count(), 0);
});

test('host-restored asks guest signaling to reconnect and rebuild lifecycle', () => {
  const signal = new FakeSignal('guest', 'g1');
  const manager = new PeerManager(signal, { RTCPeerConnection: FakePeerConnection });
  signal.emit('joined', { host: { id: 'old', role: 'host', name: 'Host' }, peers: [{ id: 'old', role: 'host', name: 'Host' }] });
  signal.emit('host-restored', { id: 'new' });
  assert.equal(signal.reconnects, 1);
  manager.destroy();
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIMITS,
  isObject,
  validCode,
  validSignal,
  validTimeline,
  validTrack
} from '../shared/protocol.js';
import { RoomState } from '../backend/room-state.js';

const ids = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
};

function fixture() {
  let now = 1_000;
  const room = new RoomState({ code: 'ABC234', now: () => now, uuid: ids() });
  const send = (connection, message) => room.dispatch(connection, message);
  return { room, send, advance(ms) { now += ms; }, now: () => now };
}

function messages(effects, to) {
  return effects.filter((e) => e.type === 'send' && (!to || e.to === to)).map((e) => e.message);
}

function welcome(effects, type) {
  return messages(effects).find((m) => m.t === type);
}

test('protocol validators are strict, finite, and runtime independent', () => {
  assert.deepEqual(LIMITS, {
    maxEncodedBytes: 32 * 1024 * 1024,
    maxGuests: 8,
    maxTracks: 100,
    signalBytes: 65_536
  });
  assert.equal(isObject({}), true);
  assert.equal(isObject([]), false);
  assert.equal(validCode('ABC234'), true);
  for (const code of ['abc234', 'ABC23', 'ABC2345', 'ABCI23', 'ABCO23', 'ABC123']) assert.equal(validCode(code), false);

  const timeline = {
    kind: 'timeline', epoch: 'epoch-1', trackId: 'track-1', seq: 1, revision: 2,
    playing: false, position: 0, atServerTime: 1000, duration: 120
  };
  assert.equal(validTimeline(timeline), true);
  assert.equal(validTimeline({ ...timeline, position: Infinity }), false);
  assert.equal(validTimeline({ ...timeline, seq: 1.5 }), false);
  assert.equal(validTimeline({ ...timeline, extra: true }), false);
  assert.equal(validTimeline({ ...timeline, atServerTime: Number.MAX_VALUE }), false);
  assert.equal(validTimeline({ ...timeline, atServerTime: Date.now() + 60_000 }), false);
  assert.equal(validTimeline({ ...timeline, atServerTime: 1 }), true);

  const track = {
    kind: 'track', epoch: 'epoch-1', trackId: 'track-1', name: 'Song',
    mime: 'audio/mpeg', size: 1024, duration: 120
  };
  assert.equal(validTrack(track), true);
  assert.equal(validTrack({ ...track, size: LIMITS.maxEncodedBytes + 1 }), false);
  assert.equal(validTrack({ ...track, duration: NaN }), false);

  assert.equal(validSignal({ sdp: { type: 'offer', sdp: 'v=0' } }), true);
  const nativeDescription = Object.create({
    toJSON() { return { type: 'offer', sdp: 'v=0' }; }
  });
  assert.equal(validSignal({ sdp: nativeDescription }), true);
  assert.equal(validSignal({ candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } }), true);
  assert.equal(validSignal({ sdp: { type: 'offer' } }), false);
  assert.equal(validSignal({ candidate: { candidate: 'x', nested: {} } }), false);
  assert.equal(validSignal({ sdp: { type: 'offer', sdp: 'x'.repeat(LIMITS.signalBytes) } }), false);
});

test('create and join produce complete welcomes and full roster', () => {
  const { room, send } = fixture();
  const created = welcome(send('host-socket', { t: 'create', name: ' Host ' }), 'created');
  assert.equal(created.role, 'host');
  assert.equal(created.host, created.id);
  assert.equal(created.code, 'ABC234');
  assert.equal(typeof created.epoch, 'string');
  assert.equal(typeof created.token, 'string');
  assert.deepEqual(created.peers, [{ id: created.id, name: 'Host', role: 'host', online: true }]);
  assert.equal(created.track, null);
  assert.equal(created.timeline, null);

  const joinedEffects = send('guest-socket', { t: 'join', name: 'Guest' });
  const joined = welcome(joinedEffects, 'joined');
  assert.equal(joined.host, created.id);
  assert.equal(joined.epoch, created.epoch);
  assert.equal(joined.peers.length, 2);
  assert.ok(messages(joinedEffects, 'host-socket').some((m) => m.t === 'peer-join' && m.id === joined.id));
  assert.ok(messages(joinedEffects).some((m) => m.t === 'roster' && m.peers.length === 2));
  assert.equal(room.hostId, created.id);
});

test('resume preserves identity and token while stale cleanup cannot evict the replacement', () => {
  const { room, send } = fixture();
  const host = welcome(send('h1', { t: 'create', name: 'Host' }), 'created');
  const guest = welcome(send('g1', { t: 'join', name: 'Guest' }), 'joined');
  room.disconnect('g1');

  const resumed = welcome(send('g2', { t: 'join', name: 'Guest 2', id: guest.id, token: guest.token }), 'joined');
  assert.equal(resumed.id, guest.id);
  assert.equal(resumed.token, guest.token);
  assert.ok(messages(room.disconnect('g1'), 'h1').every((m) => m.t !== 'peer-leave'));
  assert.equal(room.participants.get(guest.id).online, true);

  room.disconnect('h1');
  const restoredEffects = send('h2', { t: 'create', name: 'Host', id: host.id, token: host.token });
  const restored = welcome(restoredEffects, 'created');
  assert.equal(restored.id, host.id);
  assert.ok(messages(restoredEffects, 'g2').some((m) => m.t === 'host-restored'));
});

test('host loss pauses stored timeline, grace expires, and explicit leave ends immediately', () => {
  const { room, send, advance, now } = fixture();
  const host = welcome(send('h', { t: 'create', name: 'Host' }), 'created');
  const guest = welcome(send('g', { t: 'join', name: 'Guest' }), 'joined');
  const track = {
    kind: 'track', epoch: host.epoch, trackId: 'track-1', name: 'Song', mime: 'audio/mpeg', size: 10, duration: 60
  };
  send('h', { t: 'control', data: track });
  send('h', { t: 'control', data: {
    kind: 'timeline', epoch: host.epoch, trackId: 'track-1', seq: 1, revision: 1,
    playing: true, position: 2, atServerTime: now(), duration: 60
  } });
  const lost = room.disconnect('h');
  assert.ok(messages(lost, 'g').some((m) => m.t === 'host-left' && m.recovering === true));
  assert.equal(room.timeline.playing, false);

  advance(30_001);
  const expired = room.sweep();
  assert.ok(messages(expired, 'g').some((m) => m.t === 'host-left' && m.recovering === false));
  assert.equal(room.ended, true);

  const second = fixture();
  second.send('h', { t: 'create', name: 'Host' });
  second.send('g', { t: 'join', name: 'Guest' });
  const left = second.send('h', { t: 'leave' });
  assert.ok(messages(left, 'g').some((m) => m.t === 'host-left' && m.recovering === false));
  assert.equal(second.room.ended, true);
  assert.equal(guest.role, 'guest');
});

test('host-star signaling, host authority, track identity, and increasing sequence are enforced', () => {
  const { send, now } = fixture();
  const host = welcome(send('h', { t: 'create', name: 'Host' }), 'created');
  const g1 = welcome(send('g1', { t: 'join', name: 'One' }), 'joined');
  const g2 = welcome(send('g2', { t: 'join', name: 'Two' }), 'joined');

  assert.ok(messages(send('g1', { t: 'signal', to: g2.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } }), 'g1').some((m) => m.t === 'error'));
  assert.ok(messages(send('g1', { t: 'signal', to: g1.id, data: { candidate: { candidate: 'x' } } }), 'g1').some((m) => m.t === 'error'));
  assert.ok(messages(send('g1', { t: 'signal', to: host.id, data: { candidate: { candidate: 'x' } } }), 'h').some((m) => m.t === 'signal'));
  assert.ok(messages(send('h', { t: 'signal', to: g2.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } }), 'g2').some((m) => m.t === 'signal'));

  assert.ok(messages(send('g1', { t: 'control', data: {} }), 'g1').some((m) => m.t === 'error'));
  const track = { kind: 'track', epoch: host.epoch, trackId: 'a', name: 'A', mime: 'audio/mpeg', size: 1, duration: 10 };
  assert.ok(messages(send('h', { t: 'control', data: track }), 'g1').some((m) => m.t === 'control'));
  const timeline = { kind: 'timeline', epoch: host.epoch, trackId: 'a', seq: 1, revision: 1, playing: false, position: 0, atServerTime: now(), duration: 10 };
  assert.ok(messages(send('h', { t: 'control', data: timeline }), 'g1').some((m) => m.t === 'control'));
  assert.ok(messages(send('h', { t: 'control', data: { ...timeline, seq: 1 } }), 'h').some((m) => m.t === 'error'));
  assert.ok(messages(send('h', { t: 'control', data: { ...timeline, seq: 2, trackId: 'wrong' } }), 'h').some((m) => m.t === 'error'));
});

test('participant limit, register-once, malformed payload, and rate limits fail closed', () => {
  const { room, send } = fixture();
  send('h', { t: 'create', name: 'Host' });
  for (let i = 0; i < LIMITS.maxGuests; i++) {
    assert.ok(welcome(send(`g${i}`, { t: 'join', name: `G${i}` }), 'joined'));
  }
  assert.ok(messages(send('overflow', { t: 'join', name: 'No room' }), 'overflow').some((m) => m.t === 'error'));
  assert.ok(messages(send('h', { t: 'create', name: 'Again' }), 'h').some((m) => m.t === 'error'));
  assert.ok(messages(send('g0', { t: 'time', t0: Infinity }), 'g0').some((m) => m.t === 'error'));
  assert.ok(messages(send('g0', { t: 'signal', to: room.hostId, data: { candidate: { candidate: 1 } } }), 'g0').some((m) => m.t === 'error'));

  let limited = false;
  for (let i = 0; i < 200; i++) {
    if (messages(send('g0', { t: 'time', t0: i }), 'g0').some((m) => m.t === 'error' && /rate/i.test(m.msg))) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true);
});

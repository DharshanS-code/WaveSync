import test from 'node:test';
import assert from 'node:assert/strict';
import { DataChannelTransfer, TRANSFER_LIMITS } from '../src/transfer.js';

class FakeChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
    this.peer = null;
    this.block = false;
  }

  send(value) {
    if (this.readyState !== 'open') throw new Error('closed');
    const copy = typeof value === 'string' ? value
      : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength).slice().buffer;
    this.sent.push(copy);
    if (this.block && typeof value !== 'string') this.bufferedAmount = 2 * 1024 * 1024;
    queueMicrotask(() => {
      if (this.peer?.readyState === 'open') this.peer.dispatchEvent(Object.assign(new Event('message'), { data: copy }));
    });
  }

  drain() {
    this.bufferedAmount = 0;
    this.dispatchEvent(new Event('bufferedamountlow'));
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

function pair() {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const meta = (trackId) => ({
  trackId,
  epoch: 'epoch-1',
  name: `${trackId}.mp3`,
  mime: 'audio/mpeg',
  size: 0,
  duration: 180
});

function event(endpoint, type) {
  return new Promise((resolve) => endpoint.addEventListener(type, (e) => resolve(e.detail), { once: true }));
}

function deterministicBytes(size, seed) {
  const value = new Uint8Array(size);
  for (let i = 0; i < size; i++) value[i] = (i * 31 + seed) & 255;
  return value.buffer;
}

test('receive queue bounds frames waiting behind async checksum and clears on overflow', async () => {
  const channel = new FakeChannel();
  const receiver = new DataChannelTransfer(channel);
  let release;
  receiver._verifyDigest = () => new Promise(resolve => release = resolve);
  const emit = data => channel.dispatchEvent(Object.assign(new Event('message'), { data }));
  emit(JSON.stringify({kind:'file-header',transferId:'bounded',...meta('bounded'),size:0,sha256:'a'.repeat(64)}));
  emit(JSON.stringify({kind:'file-eof',transferId:'bounded'}));
  await new Promise(resolve => setImmediate(resolve));
  for(let i=0;i<2200;i++)emit(new ArrayBuffer(16384));
  assert.equal(receiver._closed,true);
  assert.equal(receiver._queuedReceiveBytes,0);
  assert.equal(receiver._receiveQueue.length,0);
  release(true);
  await receiver._receiveChain;
});

test('two interleaved 5MiB submissions are serialized and reconstructed exactly', async () => {
  const [left, right] = pair();
  const sender = new DataChannelTransfer(left);
  const receiver = new DataChannelTransfer(right);
  const one = deterministicBytes(5 * 1024 * 1024, 7);
  const two = deterministicBytes(5 * 1024 * 1024, 19);
  const done = [];
  receiver.addEventListener('file-done', (e) => done.push(e.detail));

  const results = await Promise.all([
    sender.sendFile(one, meta('one')),
    sender.sendFile(two, meta('two'))
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(results.length, 2);
  assert.deepEqual(done.map((item) => item.meta.trackId), ['one', 'two']);
  assert.deepEqual(new Uint8Array(done[0].buffer), new Uint8Array(one));
  assert.deepEqual(new Uint8Array(done[1].buffer), new Uint8Array(two));
  const controls = left.sent.filter((item) => typeof item === 'string').map(JSON.parse);
  assert.deepEqual(controls.map((item) => item.kind), ['file-header', 'file-eof', 'file-header', 'file-eof']);
  sender.close(); receiver.close();
});

test('closing during backpressure drain rejects active and queued promises', async () => {
  const [left] = pair();
  left.block = true;
  const sender = new DataChannelTransfer(left, { transferTimeoutMs: 1000 });
  const first = sender.sendFile(deterministicBytes(2 * 1024 * 1024, 1), meta('first'));
  const second = sender.sendFile(deterministicBytes(64 * 1024, 2), meta('second'));
  await new Promise((resolve) => setImmediate(resolve));
  left.close();
  const settled = await Promise.allSettled([first, second]);
  assert.deepEqual(settled.map((item) => item.status), ['rejected', 'rejected']);
  assert.match(settled[0].reason.message, /closed/i);
});

test('invalid size, oversized chunks, and truncated EOF produce transfer errors', async () => {
  const channel = new FakeChannel();
  const receiver = new DataChannelTransfer(channel);

  let errorP = event(receiver, 'transfer-error');
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({
    kind: 'file-header', transferId: 'x', ...meta('bad'), size: TRANSFER_LIMITS.maxFileBytes + 1
  }) }));
  assert.match((await errorP).message, /header/i);

  errorP = event(receiver, 'transfer-error');
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({
    kind: 'file-header', transferId: 'y', ...meta('large-frame'), size: 10
  }) }));
  channel.dispatchEvent(Object.assign(new Event('message'), { data: new Uint8Array(17 * 1024).buffer }));
  assert.match((await errorP).message, /exceeded/i);

  errorP = event(receiver, 'transfer-error');
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({
    kind: 'file-header', transferId: 'z', ...meta('short'), size: 10
  }) }));
  channel.dispatchEvent(Object.assign(new Event('message'), { data: new Uint8Array(5).buffer }));
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ kind: 'file-eof', transferId: 'z' }) }));
  assert.match((await errorP).message, /before/i);
  receiver.close();
});

test('EOF identity must match and exact zero-byte transfer completes', async () => {
  const channel = new FakeChannel();
  const receiver = new DataChannelTransfer(channel);
  let errorP = event(receiver, 'transfer-error');
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({
    kind: 'file-header', transferId: 'correct', ...meta('mismatch'), size: 0
  }) }));
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ kind: 'file-eof', transferId: 'wrong' }) }));
  assert.match((await errorP).message, /unexpected/i);

  const doneP = event(receiver, 'file-done');
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({
    kind: 'file-header', transferId: 'empty', ...meta('empty'), size: 0
  }) }));
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ kind: 'file-eof', transferId: 'empty' }) }));
  const done = await doneP;
  assert.equal(done.buffer.byteLength, 0);
  assert.equal(done.meta.trackId, 'empty');
  receiver.close();
});

test('empty binary body frames are rejected without accumulating chunks', async () => {
  const channel = new FakeChannel();
  const receiver = new DataChannelTransfer(channel);
  const errorP = event(receiver, 'transfer-error');
  channel.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({
    kind: 'file-header', transferId: 'empty-frame', ...meta('empty-frame'), size: 1
  }) }));
  channel.dispatchEvent(Object.assign(new Event('message'), { data: new ArrayBuffer(0) }));
  assert.match((await errorP).message, /exceeded/i);
  receiver.close();
});

test('sender reports delivery measurements to adaptive network quality', async () => {
  const [left] = pair();
  const deliveries = [];
  const networkQuality = {
    profile: () => ({ maxBufferedBytes: 256 * 1024, transferTimeoutMs: 60_000 }),
    delivery: (sample) => deliveries.push(sample)
  };
  const sender = new DataChannelTransfer(left, { networkQuality });
  await sender.sendFile(new ArrayBuffer(1024), meta('quality'));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].bytes, 1024);
  assert.ok(deliveries[0].durationMs >= 0);
  assert.ok(deliveries[0].stalledMs >= 0);
  sender.close();
});

test('sender rejects malformed identity, oversize input, and queue overflow', async () => {
  const channel = new FakeChannel();
  channel.block = true;
  const sender = new DataChannelTransfer(channel, { maxTransferQueue: 1 });
  await assert.rejects(sender.sendFile(new ArrayBuffer(1), { ...meta(''), trackId: '' }), /metadata/i);
  await assert.rejects(sender.sendFile(new ArrayBuffer(TRANSFER_LIMITS.maxFileBytes + 1), meta('huge')), /size/i);
  const first = sender.sendFile(deterministicBytes(2 * 1024 * 1024, 3), meta('one'));
  const second = sender.sendFile(new ArrayBuffer(1), meta('two'));
  await assert.rejects(sender.sendFile(new ArrayBuffer(1), meta('three')), /queue/i);
  sender.close();
  await Promise.allSettled([first, second]);
});

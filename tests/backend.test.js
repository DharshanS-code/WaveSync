import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { createDevServer } from '../backend/dev-server.js';

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function next(ws, type, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeout);
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!type || message.t === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(message);
      }
    };
    ws.on('message', handler);
  });
}

async function closeServer(server) {
  for (const client of server.wss.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
}

test('dev server has health endpoint, validates websocket route, and relays safely', async (t) => {
  const server = createDevServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => closeServer(server));
  const { port } = server.address();

  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'wavesync-signal' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/room?code=ABC234`)).status, 426);
  assert.equal((await fetch(`http://127.0.0.1:${port}/missing`)).status, 404);

  const bad = new WebSocket(`ws://127.0.0.1:${port}/api/room?code=BAD`);
  const [, response] = await once(bad, 'unexpected-response');
  assert.equal(response.statusCode, 400);

  const host = await open(`ws://127.0.0.1:${port}/api/room?code=ABC234`);
  host.send(JSON.stringify({ t: 'create', name: 'Host' }));
  const created = await next(host, 'created');
  assert.equal(created.role, 'host');

  const guest = await open(`ws://127.0.0.1:${port}/api/room?code=ABC234`);
  guest.send(JSON.stringify({ t: 'join', name: 'Guest' }));
  const joined = await next(guest, 'joined');
  assert.equal(joined.host, created.id);
  const peerJoin = await next(host, 'peer-join');
  assert.equal(peerJoin.id, joined.id);

  const signalPromise = next(host, 'signal');
  guest.send(JSON.stringify({ t: 'signal', to: created.id, data: { candidate: { candidate: 'candidate:1' } } }));
  assert.equal((await signalPromise).from, joined.id);

  host.close(1000);
  assert.equal((await next(guest, 'host-left')).recovering, true);
  guest.close();
});

test('stale room cleanup cannot delete a replacement room', async (t) => {
  const server = createDevServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => closeServer(server));
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/api/room?code=ABC234`;

  const oldHost = await open(url);
  oldHost.send(JSON.stringify({ t: 'create', name: 'Old host' }));
  await next(oldHost, 'created');
  const oldGuest = await open(url);
  oldGuest.send(JSON.stringify({ t: 'join', name: 'Old guest' }));
  await next(oldGuest, 'joined');
  oldHost.send(JSON.stringify({ t: 'leave' }));
  await once(oldHost, 'close');

  const replacement = await open(url);
  replacement.send(JSON.stringify({ t: 'create', name: 'Replacement' }));
  const created = await next(replacement, 'created');
  oldGuest.close();
  await once(oldGuest, 'close');

  const newcomer = await open(url);
  newcomer.send(JSON.stringify({ t: 'join', name: 'New guest' }));
  assert.equal((await next(newcomer, 'joined')).host, created.id);
  newcomer.close();
  replacement.close();
});

test('pending socket survives cleanup of another empty socket for the same room', async (t) => {
  const server = createDevServer({ port: 0, host: '127.0.0.1', handshakeTimeoutMs: 1000 });
  await once(server, 'listening');
  t.after(() => closeServer(server));
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/api/room?code=ABC234`;

  const first = await open(url);
  const pending = await open(url);
  first.close();
  await once(first, 'close');
  pending.send(JSON.stringify({ t: 'create', name: 'Host' }));
  const created = await next(pending, 'created');

  const guest = await open(url);
  guest.send(JSON.stringify({ t: 'join', name: 'Guest' }));
  assert.equal((await next(guest, 'joined')).host, created.id);
  guest.close();
  pending.close();
});

test('dev server enforces handshake timeout and 64KiB payload limit before registration', async (t) => {
  const server = createDevServer({ port: 0, host: '127.0.0.1', handshakeTimeoutMs: 1000 });
  await once(server, 'listening');
  t.after(() => closeServer(server));
  const { port } = server.address();

  const idle = await open(`ws://127.0.0.1:${port}/api/room?code=ABC234`);
  const [code] = await once(idle, 'close');
  assert.equal(code, 1008);

  const oversized = await open(`ws://127.0.0.1:${port}/api/room?code=ABC234`);
  oversized.send(JSON.stringify({ t: 'create', name: 'x'.repeat(65_536) }));
  const [largeCode] = await once(oversized, 'close');
  assert.equal(largeCode, 1009);
});

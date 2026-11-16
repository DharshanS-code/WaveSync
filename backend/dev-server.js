import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import { RoomState } from './room-state.js';
import { LIMITS, validCode } from '../shared/protocol.js';

const HEARTBEAT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function applyEffects(effects) {
  for (const effect of effects) {
    const ws = effect.to;
    if (effect.type === 'send' && ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(effect.message)); } catch { /* close/error cleanup owns state */ }
    } else if (effect.type === 'close' && ws && ws.readyState < WebSocket.CLOSING) {
      try { ws.close(effect.code, effect.reason); } catch { ws.terminate(); }
    }
  }
}

export function createDevServer({
  port = 8787,
  host = '127.0.0.1',
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  now = () => Date.now(),
  uuid = randomUUID
} = {}) {
  const rooms = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || host}`);
    if (request.method === 'GET' && url.pathname === '/api/health') {
      json(response, 200, { ok: true, service: 'wavesync-signal' });
      return;
    }
    if (url.pathname === '/api/room') {
      response.writeHead(426, { connection: 'close', upgrade: 'websocket', 'cache-control': 'no-store' });
      response.end('Expected WebSocket');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('Not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.signalBytes });
  const pendingByRoom = new Map();
  server.wss = wss;
  server.rooms = rooms;

  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url || '/', `http://${request.headers.host || host}`); } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const code = url.searchParams.get('code') || '';
    if (url.pathname !== '/api/room') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!validCode(code)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid room code');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, code));
  });

  wss.on('connection', (ws, _request, code) => {
    pendingByRoom.set(code, (pendingByRoom.get(code) || 0) + 1);
    let pending = true;
    let room = rooms.get(code);
    if (!room || room.ended) {
      room = new RoomState({ code, now, uuid });
      rooms.set(code, room);
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const handshakeTimer = setTimeout(() => {
      if (!room.connections.get(ws)?.participantId && ws.readyState === WebSocket.OPEN) ws.close(1008, 'Registration timeout');
    }, handshakeTimeoutMs);
    handshakeTimer.unref?.();

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        applyEffects(room.dispatch(ws, null));
        return;
      }
      let message;
      try { message = JSON.parse(raw.toString()); } catch {
        applyEffects(room.dispatch(ws, null));
        return;
      }
      const effects = room.dispatch(ws, message);
      if (room.connections.get(ws)?.participantId) {
        clearTimeout(handshakeTimer);
        if (pending) {
          pending = false;
          const count = (pendingByRoom.get(code) || 1) - 1;
          if (count) pendingByRoom.set(code, count);
          else pendingByRoom.delete(code);
        }
      }
      applyEffects(effects);
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(handshakeTimer);
      if (pending) {
        pending = false;
        const count = (pendingByRoom.get(code) || 1) - 1;
        if (count) pendingByRoom.set(code, count);
        else pendingByRoom.delete(code);
      }
      applyEffects(room.disconnect(ws));
      if (rooms.get(code) === room && !pendingByRoom.has(code)
        && (room.participants.size === 0 || room.canDelete())) rooms.delete(code);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }
    for (const [code, room] of rooms) {
      applyEffects(room.sweep());
      if (!pendingByRoom.has(code) && room.canDelete()) rooms.delete(code);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  server.on('close', () => {
    clearInterval(heartbeat);
    wss.close();
  });
  server.listen(port, host);
  return server;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirect) {
  const port = process.env.PORT ? Number(process.env.PORT) : 8787;
  const host = process.env.HOST || '127.0.0.1';
  const server = createDevServer({ port, host });
  server.on('listening', () => console.log(`[wavesync] signaling server on ws://${host}:${server.address().port}/api/room`));
}

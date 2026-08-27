/**
 * WaveSync local dev signaling server (Node + ws).
 * Mirrors the Cloudflare Worker/Durable Object protocol so you can test the
 * full app locally before deploying to Cloudflare.
 *
 *   node backend/dev-server.js         # listens on ws://localhost:8787/api/room
 *   PORT=9000 node backend/dev-server.js
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const CODE_RE = /^[A-Z0-9]{4,8}$/;

const rooms = new Map(); // code -> { hostId, clients: Map(id -> {ws, role, name}) }

const wss = new WebSocketServer({ port: PORT, path: '/api/room' });
console.log(`[wavesync] signaling server on ws://localhost:${PORT}/api/room`);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const code = (url.searchParams.get('code') || '').toUpperCase();
  if (!CODE_RE.test(code)) { ws.close(1008, 'Invalid room code'); return; }

  if (!rooms.has(code)) rooms.set(code, { hostId: null, clients: new Map() });
  const room = rooms.get(code);
  const id = randomUUID();
  let session = null;

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const sendToId = (tid, obj) => { const c = room.clients.get(tid); if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(obj)); };
  const broadcast = (exceptId, obj) => { for (const [cid, c] of room.clients) if (cid !== exceptId && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(obj)); };
  const clean = (v, fb) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 40) : fb;

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;

    switch (m.t) {
      case 'create':
        if (room.hostId && room.clients.has(room.hostId)) return send({ t: 'error', msg: 'Room code already in use' });
        room.hostId = id;
        session = { ws, role: 'host', name: clean(m.name, 'Host') };
        room.clients.set(id, session);
        send({ t: 'created', code, id, role: 'host' });
        break;
      case 'join':
        if (!room.hostId || !room.clients.has(room.hostId)) return send({ t: 'error', msg: 'Room not found' });
        session = { ws, role: 'guest', name: clean(m.name, 'Guest') };
        room.clients.set(id, session);
        send({ t: 'joined', code, id, role: 'guest', host: room.hostId });
        sendToId(room.hostId, { t: 'peer-join', id, role: 'guest', name: session.name });
        break;
      case 'time':
        send({ t: 'time', t0: m.t0, t1: Date.now() });
        break;
      case 'signal':
        if (!session || typeof m.to !== 'string') return;
        sendToId(m.to, { t: 'signal', from: id, data: m.data });
        break;
      case 'control':
        if (!session || session.role !== 'host') return;
        broadcast(id, { t: 'control', from: id, data: m.data });
        break;
      case 'leave':
        try { ws.close(1000); } catch (e) {}
        break;
    }
  });

  const cleanup = () => {
    room.clients.delete(id);
    if (id === room.hostId) { room.hostId = null; broadcast(id, { t: 'host-left' }); }
    else if (room.hostId) sendToId(room.hostId, { t: 'peer-leave', id });
    if (room.clients.size === 0) rooms.delete(code);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

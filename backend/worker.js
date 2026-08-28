/**
 * WaveSync signaling — Cloudflare Worker + Durable Object.
 *
 * One Durable Object instance per room code (addressed by name = code).
 * Responsibilities: room lifecycle, WebRTC signaling relay, clock echo,
 * playback-control broadcast, session/roster management.
 *
 * Deploy:  cd backend && npx wrangler deploy   (see wrangler.toml)
 * Route:   GET /api/room?code=XXXXXX   (WebSocket upgrade)
 */

const CODE_RE = /^[A-Z0-9]{4,8}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'wavesync-signal' });
    }

    if (url.pathname === '/api/room') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!CODE_RE.test(code)) return new Response('Invalid room code', { status: 400 });

      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return new Response('WaveSync signaling', { status: 200 });
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
export class RoomDO {
  constructor(state) {
    this.state = state;
    this.code = null;
    this.hostId = null;
    this.clients = new Map(); // id -> { ws, role, name }
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.code = (url.searchParams.get('code') || this.code || 'ROOM').toUpperCase();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws) {
    const id = crypto.randomUUID();
    let session = null; // set on create/join

    ws.addEventListener('message', (evt) => {
      let m;
      try { m = JSON.parse(evt.data); } catch { return; }
      if (typeof m !== 'object' || !m) return;

      switch (m.t) {
        case 'create': {
          if (this.hostId && this.clients.has(this.hostId)) {
            return this.sendTo(ws, { t: 'error', msg: 'Room code already in use' });
          }
          this.hostId = id;
          session = { ws, role: 'host', name: str(m.name, 'Host') };
          this.clients.set(id, session);
          this.sendTo(ws, { t: 'created', code: this.code, id, role: 'host' });
          break;
        }
        case 'join': {
          if (!this.hostId || !this.clients.has(this.hostId)) {
            return this.sendTo(ws, { t: 'error', msg: 'Room not found' });
          }
          session = { ws, role: 'guest', name: str(m.name, 'Guest') };
          this.clients.set(id, session);
          this.sendTo(ws, { t: 'joined', code: this.code, id, role: 'guest', host: this.hostId });
          // Notify host of the new guest so it can initiate WebRTC.
          this.sendToId(this.hostId, { t: 'peer-join', id, role: 'guest', name: session.name });
          break;
        }
        case 'time': {
          this.sendTo(ws, { t: 'time', t0: m.t0, t1: Date.now() });
          break;
        }
        case 'signal': {
          if (!session || typeof m.to !== 'string') return;
          this.sendToId(m.to, { t: 'signal', from: id, data: m.data });
          break;
        }
        case 'control': {
          if (!session || session.role !== 'host') return; // host-authoritative
          this.broadcast(id, { t: 'control', from: id, data: m.data });
          break;
        }
        case 'leave': {
          try { ws.close(1000); } catch (e) {}
          break;
        }
      }
    });

    const cleanup = () => {
      this.clients.delete(id);
      if (id === this.hostId) {
        this.hostId = null;
        this.broadcast(id, { t: 'host-left' });
      } else if (this.hostId) {
        this.sendToId(this.hostId, { t: 'peer-leave', id });
      }
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  sendTo(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  sendToId(id, obj) { const c = this.clients.get(id); if (c) this.sendTo(c.ws, obj); }
  broadcast(exceptId, obj) {
    for (const [cid, c] of this.clients) if (cid !== exceptId) this.sendTo(c.ws, obj);
  }
}

function str(v, fallback) {
  return (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 40) : fallback;
}

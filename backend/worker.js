import { RoomState } from './room-state.js';
import { LIMITS, validCode } from '../shared/protocol.js';

const HANDSHAKE_TIMEOUT_MS = 10_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true, service: 'wavesync-signal' });
    if (url.pathname === '/api/room') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426, headers: { 'cache-control': 'no-store' } });
      }
      const code = url.searchParams.get('code') || '';
      if (!validCode(code)) return new Response('Invalid room code', { status: 400 });
      if (!env.ROOMS) return new Response('Room service unavailable', { status: 503 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    if (env.ASSETS?.fetch) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};

export class RoomDO {
  constructor(state) {
    this.state = state;
    this.room = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code') || '';
    if (!validCode(code)) return new Response('Invalid room code', { status: 400 });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    if (!this.room || (this.room.ended && this.room.canDelete())) this.room = new RoomState({ code });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws) {
    const room = this.room;
    let cleaned = false;
    const handshakeTimer = setTimeout(() => {
      if (!room.connections.get(ws)?.participantId) {
        try { ws.close(1008, 'Registration timeout'); } catch { /* cleanup event follows */ }
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        this.apply(room.dispatch(ws, null));
        return;
      }
      const bytes = typeof TextEncoder === 'undefined' ? event.data.length : new TextEncoder().encode(event.data).byteLength;
      if (bytes > LIMITS.signalBytes) {
        try { ws.close(1009, 'Message too large'); } catch { /* cleanup event follows */ }
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch {
        this.apply(room.dispatch(ws, null));
        return;
      }
      this.apply(room.dispatch(ws, message));
      if (room.connections.get(ws)?.participantId) clearTimeout(handshakeTimer);
    });

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(handshakeTimer);
      this.apply(room.disconnect(ws));
      this.scheduleSweep();
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  apply(effects) {
    for (const effect of effects) {
      try {
        if (effect.type === 'send') effect.to.send(JSON.stringify(effect.message));
        else if (effect.type === 'close') effect.to.close(effect.code, effect.reason);
      } catch {
        // Socket lifecycle events perform generation-safe cleanup.
      }
    }
  }

  scheduleSweep() {
    if (!this.state.storage?.setAlarm) return;
    const now = Date.now();
    const deadlines = [...this.room.participants.values()]
      .filter((participant) => !participant.online && Number.isFinite(participant.expiresAt) && participant.expiresAt > now)
      .map((participant) => participant.expiresAt);
    if (!deadlines.length) {
      this.state.storage.deleteAlarm?.();
      return;
    }
    this.state.storage.setAlarm(Math.min(...deadlines));
  }

  async alarm() {
    if (!this.room) return;
    this.apply(this.room.sweep());
    this.scheduleSweep();
  }
}

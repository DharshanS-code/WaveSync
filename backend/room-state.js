import { LIMITS, isObject, validSignal, validTimeline, validTrack } from '../shared/protocol.js';

export const GRACE = Object.freeze({ host: 30_000, guest: 120_000 });

const NAME_MAX = 40;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 120;

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error('RoomState requires crypto.randomUUID or an injected uuid function');
}

function cleanName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const name = value.trim();
  return name ? name.slice(0, NAME_MAX) : fallback;
}

function send(to, message) {
  return { type: 'send', to, message };
}

function close(to, code = 1000, reason = '') {
  return { type: 'close', to, code, reason };
}

export class RoomState {
  constructor({ code, now = () => Date.now(), uuid = defaultUuid } = {}) {
    this.code = code;
    this.now = now;
    this.uuid = uuid;
    this.epoch = uuid();
    this.hostId = null;
    this.participants = new Map();
    this.connections = new Map();
    this.track = null;
    this.timeline = null;
    this.lastSeq = -1;
    this.trackIds = new Set();
    this.ended = false;
  }

  dispatch(connection, message) {
    const effects = [];
    const state = this.connections.get(connection);
    if (!this.takeRate(connection, state)) return this.error(connection, 'Rate limit exceeded');
    if (!isObject(message) || typeof message.t !== 'string') return this.error(connection, 'Malformed message');

    if (message.t === 'create' || message.t === 'join') {
      if (state?.participantId) return this.error(connection, 'Connection already registered');
      return this.register(connection, message, effects);
    }
    if (message.t === 'time') {
      if (!Number.isFinite(message.t0)) return this.error(connection, 'Invalid time request');
      effects.push(send(connection, { t: 'time', t0: message.t0, t1: this.now() }));
      return effects;
    }
    if (!state?.participantId) return this.error(connection, 'Register first');
    const participant = this.participants.get(state.participantId);
    if (!participant || participant.generation !== state.generation || !participant.online) {
      return this.error(connection, 'Session is no longer active');
    }

    switch (message.t) {
      case 'signal':
        return this.signal(connection, participant, message);
      case 'control':
        return this.control(connection, participant, message.data);
      case 'leave':
        return this.leave(connection, participant);
      default:
        return this.error(connection, 'Unknown message type');
    }
  }

  register(connection, message, effects) {
    if (!this.validRegistration(message)) return this.error(connection, 'Invalid registration');
    const role = message.t === 'create' ? 'host' : 'guest';
    let participant = null;
    let resumed = false;

    if (message.id !== undefined || message.token !== undefined) {
      if (typeof message.id !== 'string' || typeof message.token !== 'string') return this.error(connection, 'Invalid resume credentials');
      participant = this.participants.get(message.id);
      if (!participant || participant.token !== message.token || participant.role !== role || participant.expiresAt <= this.now()) {
        return this.error(connection, 'Invalid or expired resume credentials');
      }
      resumed = true;
    }

    if (this.ended) return this.error(connection, 'Room has ended');
    if (role === 'host') {
      const host = this.hostId && this.participants.get(this.hostId);
      if (!resumed && host) return this.error(connection, 'Room code already in use');
    } else {
      const host = this.hostId && this.participants.get(this.hostId);
      if (!host) return this.error(connection, 'Room not found');
      if (!resumed && this.guestCount() >= LIMITS.maxGuests) return this.error(connection, 'Room is full');
    }

    if (!participant) {
      const id = this.uuid();
      participant = {
        id,
        token: this.uuid(),
        role,
        name: cleanName(message.name, role === 'host' ? 'Host' : 'Guest'),
        online: false,
        connection: null,
        generation: 0,
        expiresAt: Infinity
      };
      this.participants.set(id, participant);
      if (role === 'host') this.hostId = id;
    } else {
      participant.name = cleanName(message.name, participant.name);
      if (participant.connection && participant.connection !== connection) effects.push(close(participant.connection, 1008, 'Session resumed elsewhere'));
    }

    participant.generation += 1;
    participant.connection = connection;
    participant.online = true;
    participant.expiresAt = Infinity;
    this.connections.set(connection, { participantId: participant.id, generation: participant.generation, rateStart: this.now(), rateCount: 1 });

    const type = role === 'host' ? 'created' : 'joined';
    effects.push(send(connection, this.welcome(type, participant)));
    if (role === 'guest') {
      const host = this.participants.get(this.hostId);
      if (host?.online) effects.push(send(host.connection, { t: 'peer-join', id: participant.id, name: participant.name, role: 'guest', resumed }));
    } else if (resumed) {
      this.timeline = this.timeline ? { ...this.timeline, playing: false, atServerTime: this.now() } : null;
      for (const guest of this.onlineGuests()) effects.push(send(guest.connection, { t: 'host-restored', id: participant.id, epoch: this.epoch }));
    }
    effects.push(...this.rosterEffects());
    return effects;
  }

  validRegistration(message) {
    const allowed = new Set(['t', 'name', 'id', 'token']);
    if (Object.keys(message).some((key) => !allowed.has(key))) return false;
    if (message.name !== undefined && typeof message.name !== 'string') return false;
    return message.id === undefined || typeof message.id === 'string';
  }

  signal(connection, participant, message) {
    if (typeof message.to !== 'string' || !validSignal(message.data)) return this.error(connection, 'Invalid signal');
    const target = this.participants.get(message.to);
    if (!target?.online || target.id === participant.id) return this.error(connection, 'Invalid signal target');
    if (participant.role !== 'host' && target.role !== 'host') return this.error(connection, 'Signaling must use the host star');
    if (participant.role === 'host' && target.role !== 'guest') return this.error(connection, 'Invalid signal target');
    return [send(target.connection, { t: 'signal', from: participant.id, data: message.data })];
  }

  control(connection, participant, data) {
    if (participant.role !== 'host' || participant.id !== this.hostId) return this.error(connection, 'Host only');
    if (validTrack(data)) {
      if (data.epoch !== this.epoch) return this.error(connection, 'Wrong room epoch');
      if (this.trackIds.size >= LIMITS.maxTracks && !this.trackIds.has(data.trackId)) return this.error(connection, 'Track limit exceeded');
      this.trackIds.add(data.trackId);
      this.track = { ...data };
      this.timeline = null;
      return this.broadcast(participant.id, { t: 'control', from: participant.id, data: this.track });
    }
    if (validTimeline(data, this.now())) {
      if (data.epoch !== this.epoch || !this.track || data.trackId !== this.track.trackId || data.duration !== this.track.duration) {
        return this.error(connection, 'Timeline does not match active track');
      }
      if (data.seq <= this.lastSeq) return this.error(connection, 'Timeline sequence must increase');
      this.lastSeq = data.seq;
      this.timeline = { ...data };
      return this.broadcast(participant.id, { t: 'control', from: participant.id, data: this.timeline });
    }
    return this.error(connection, 'Invalid control payload');
  }

  leave(connection, participant) {
    const effects = [];
    this.detach(connection, participant, effects, true);
    effects.push(close(connection, 1000, 'Left room'));
    return effects;
  }

  disconnect(connection) {
    const state = this.connections.get(connection);
    if (!state?.participantId) {
      this.connections.delete(connection);
      return [];
    }
    const participant = this.participants.get(state.participantId);
    if (!participant || participant.generation !== state.generation || participant.connection !== connection) {
      this.connections.delete(connection);
      return [];
    }
    const effects = [];
    this.detach(connection, participant, effects, false);
    return effects;
  }

  detach(connection, participant, effects, explicit) {
    this.connections.delete(connection);
    if (participant.connection !== connection) return;
    participant.online = false;
    participant.connection = null;
    if (participant.role === 'host') {
      if (this.timeline) this.timeline = { ...this.timeline, playing: false, atServerTime: this.now() };
      if (explicit) {
        participant.expiresAt = this.now();
        this.ended = true;
        for (const guest of this.onlineGuests()) effects.push(send(guest.connection, { t: 'host-left', recovering: false }));
      } else {
        participant.expiresAt = this.now() + GRACE.host;
        for (const guest of this.onlineGuests()) effects.push(send(guest.connection, { t: 'host-left', recovering: true }));
      }
    } else {
      participant.expiresAt = explicit ? this.now() : this.now() + GRACE.guest;
      const host = this.participants.get(this.hostId);
      if (host?.online) effects.push(send(host.connection, { t: 'peer-leave', id: participant.id, recovering: !explicit }));
      if (explicit) this.participants.delete(participant.id);
    }
    effects.push(...this.rosterEffects());
  }

  sweep() {
    const effects = [];
    const now = this.now();
    for (const participant of [...this.participants.values()]) {
      if (participant.online || participant.expiresAt > now) continue;
      if (participant.role === 'host') {
        if (!this.ended) {
          this.ended = true;
          for (const guest of this.onlineGuests()) effects.push(send(guest.connection, { t: 'host-left', recovering: false }));
        }
      } else {
        this.participants.delete(participant.id);
      }
    }
    if (effects.length) effects.push(...this.rosterEffects());
    return effects;
  }

  takeRate(connection, state) {
    const now = this.now();
    const current = state || this.connections.get(connection) || { participantId: null, generation: 0, rateStart: now, rateCount: 0 };
    if (now - current.rateStart >= RATE_WINDOW_MS) {
      current.rateStart = now;
      current.rateCount = 0;
    }
    current.rateCount += 1;
    if (!state) this.connections.set(connection, current);
    return current.rateCount <= RATE_MAX;
  }

  error(connection, msg) {
    return [send(connection, { t: 'error', msg })];
  }

  guestCount() {
    let count = 0;
    for (const participant of this.participants.values()) if (participant.role === 'guest') count += 1;
    return count;
  }

  *onlineGuests() {
    for (const participant of this.participants.values()) if (participant.role === 'guest' && participant.online) yield participant;
  }

  peerList() {
    return [...this.participants.values()].map(({ id, name, role, online }) => ({ id, name, role, online }));
  }

  welcome(t, participant) {
    return {
      t,
      id: participant.id,
      role: participant.role,
      code: this.code,
      host: this.hostId,
      epoch: this.epoch,
      token: participant.token,
      peers: this.peerList(),
      track: this.track,
      timeline: this.timeline
    };
  }

  rosterEffects() {
    const message = { t: 'roster', peers: this.peerList() };
    return [...this.participants.values()].filter((p) => p.online).map((p) => send(p.connection, message));
  }

  broadcast(exceptId, message) {
    return [...this.participants.values()]
      .filter((participant) => participant.online && participant.id !== exceptId)
      .map((participant) => send(participant.connection, message));
  }

  canDelete() {
    if (!this.ended) return false;
    return ![...this.participants.values()].some((participant) => participant.online);
  }
}

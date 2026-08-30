// sync-engine.js — event-driven synchronization engine for WaveSync.
//
// Pipeline:  time samples -> ClockSynchronizer -> shared GMT clock
//            host timeline -> SyncEngine -> DriftController -> AudioEngine
//
// Sign convention (NEVER invert): error = localPosition - expectedPosition.
//   error > 0  => this device is AHEAD of the host  => slow down (rate < 1)
//   error < 0  => this device is BEHIND the host     => speed up  (rate > 1)

/** Minimal synchronous event emitter used across the engine. */
export class Emitter {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) { set = new Set(); this._handlers.set(type, set); }
    set.add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { const set = this._handlers.get(type); if (set) set.delete(fn); }
  once(type, fn) { const off = this.on(type, (d) => { off(); fn(d); }); return off; }
  emit(type, data) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) { try { fn(data); } catch (e) { /* isolate handlers */ } }
  }
  clear() { this._handlers.clear(); }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stddev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
};
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * ClockDriftKalman — 2-state Kalman filter tracking [offset, driftRate].
 * A phone's clock isn't just off by a fixed amount from the server — it
 * runs fast or slow by some roughly-constant rate (tens of ppm, different
 * per device). Modeling that rate as a second state lets the filter
 * extrapolate accurately BETWEEN samples instead of only ever trusting the
 * last snapshot, which is what causes a plain offset filter to slowly
 * re-drift over a long session even when every sample was fused correctly.
 *
 * State:    x = [offset (ms), rate (ms of drift per second elapsed)]
 * Model:    offset(t+dt) = offset(t) + rate(t)*dt   (constant-rate model)
 *           rate(t+dt)   = rate(t) + processNoise    (rate itself wanders slowly)
 * This is the same state structure NTP/PTP clock-discipline algorithms use.
 */
export class ClockDriftKalman {
  constructor(processNoise = 1e-3) {
    this.q = processNoise;  // process noise intensity (how fast the rate itself can wander)
    this.x0 = 0;            // offset state (ms)
    this.x1 = 0;            // rate state (ms/s)
    this.p00 = 1e8; this.p01 = 0; this.p10 = 0; this.p11 = 1; // state covariance
    this.init = false;
  }

  /** Propagate the state dt seconds forward with no new measurement (F = [[1,dt],[0,1]]). */
  _predict(dt) {
    if (dt <= 0) return;
    this.x0 = this.x0 + this.x1 * dt;
    const p00 = this.p00 + dt * (this.p01 + this.p10) + dt * dt * this.p11;
    const p01 = this.p01 + dt * this.p11;
    const p10 = this.p10 + dt * this.p11;
    const p11 = this.p11;
    // Discretized white-noise-on-rate process model (standard clock-KF Q matrix).
    this.p00 = p00 + (this.q * dt * dt * dt) / 3;
    this.p01 = p01 + (this.q * dt * dt) / 2;
    this.p10 = p10 + (this.q * dt * dt) / 2;
    this.p11 = p11 + this.q * dt;
  }

  /** Fuse a new offset measurement (ms), variance measVar (ms^2), dt seconds after the last update. */
  update(z, measVar, dt) {
    const r = Math.max(1, measVar);
    if (!this.init) {
      this.x0 = z; this.x1 = 0;
      this.p00 = r; this.p01 = 0; this.p10 = 0; this.p11 = 1;
      this.init = true;
      return;
    }
    this._predict(dt);
    const y = z - this.x0;              // innovation (H = [1, 0])
    const s = this.p00 + r;
    const k0 = this.p00 / s, k1 = this.p10 / s;
    this.x0 += k0 * y;
    this.x1 += k1 * y;
    const p00 = this.p00, p01 = this.p01, p10 = this.p10, p11 = this.p11;
    this.p00 = p00 - k0 * p00;
    this.p01 = p01 - k0 * p01;
    this.p10 = p10 - k1 * p00;
    this.p11 = p11 - k1 * p01;
  }

  /** Extrapolated offset `dt` seconds after the last update, without touching state. */
  extrapolate(dt) { return this.x0 + this.x1 * Math.max(0, dt); }

  reset() {
    this.init = false; this.x0 = 0; this.x1 = 0;
    this.p00 = 1e8; this.p01 = 0; this.p10 = 0; this.p11 = 1;
  }
}

/**
 * ClockSynchronizer — estimates the offset between this device's wall clock
 * (Date.now) and the signaling server's shared GMT/UTC clock using NTP-style
 * round trips, with min-RTT anchoring, outlier rejection, and a 2-state
 * Kalman filter that tracks offset AND drift-rate (see ClockDriftKalman).
 * Emits: 'sync' (first lock), 'update' (every sample).
 */
export class ClockSynchronizer extends Emitter {
  constructor(cfg = {}) {
    super();
    this.window = cfg.clockWindow || 30;
    this.rtt = Infinity;      // best-seen round-trip time in the current window (ms)
    this.jitter = 0;          // rtt standard deviation (ms)
    this.confidence = 0;      // 0..1 quality score
    this.synced = false;
    this._rtts = [];          // rolling window of RTTs (ms), all samples incl. outliers
    this._acceptedFlags = []; // parallel rolling window: 1 = fed to filter, 0 = rejected outlier
    this._minSamples = cfg.calibMinSamples || 5;
    this._lastT = 0;          // local time (ms) of the last sample fed to the filter
    this.kf = new ClockDriftKalman(cfg.clockProcessNoise || 1e-3);
  }

  /** Live extrapolated offset (ms) — always current, not frozen at the last sample. */
  get offset() {
    if (!this.kf.init) return 0;
    const dt = Math.max(0, (Date.now() - this._lastT) / 1000);
    return this.kf.extrapolate(dt);
  }

  /** Estimated clock skew in parts-per-million, mostly for telemetry. */
  get driftPpm() { return this.kf.init ? this.kf.x1 * 1000 : 0; }

  /** Ingest one round trip. t0 = send (local), t1 = server, t2 = recv (local). */
  addSample(t0, t1, t2) {
    const rtt = t2 - t0;
    if (rtt < 0 || !isFinite(rtt)) return this.quality();
    const rawOffset = t1 - (t0 + t2) / 2;

    this._rtts.push(rtt);
    if (this._rtts.length > this.window) this._rtts.shift();
    const med = median(this._rtts);
    const isOutlier = rtt > med * 2.5 + 5;   // reject spikes, same heuristic as before

    this._acceptedFlags.push(isOutlier ? 0 : 1);
    if (this._acceptedFlags.length > this.window) this._acceptedFlags.shift();

    this.rtt = Math.min(...this._rtts);
    this.jitter = stddev(this._rtts);

    if (!isOutlier) {
      const dt = this.kf.init ? clamp((t2 - this._lastT) / 1000, 0, 300) : 0;
      const measVar = Math.max(1, (rtt * rtt) / 4); // trust low-RTT samples more
      this.kf.update(rawOffset, measVar, dt);
      this._lastT = t2;
      if (!this.synced) { this.synced = true; this.emit('sync', this.quality()); }
    }

    const acceptedInWindow = this._acceptedFlags.reduce((a, b) => a + b, 0);
    this.confidence = clamp(acceptedInWindow / this._minSamples, 0, 1) * clamp(1 - this.jitter / 150, 0, 1);

    const q = this.quality();
    this.emit('update', q);
    return q;
  }

  /** Shared server-time estimate (ms since epoch, GMT). */
  now() { return Date.now() + this.offset; }

  quality() {
    return {
      offset: this.offset, rtt: this.rtt, jitter: this.jitter, confidence: this.confidence,
      samples: this._rtts.length, synced: this.synced, driftPpm: this.driftPpm
    };
  }

  reset() {
    this._rtts = []; this._acceptedFlags = []; this.synced = false;
    this.confidence = 0; this.rtt = Infinity; this.jitter = 0; this._lastT = 0;
    this.kf.reset();
  }
}

// Backward-compatible alias.
export const ClockSync = ClockSynchronizer;

/**
 * DeadbeatController — time-optimal drift correction. Given the current error
 * it computes a constant rate deviation `u` and the EXACT duration for the
 * error to reach 0 (error decays linearly: de/dt = rate - 1 = u, so it hits 0
 * at t = |error| / |u|). Playback then returns to rate 1 and stays stationary
 * at 0. A dead-band holds (no change) when already within ±tol of zero.
 *
 * Sign convention (never inverted): error = local - expected.
 *   error > 0 (ahead)  -> u < 0 (slow down)
 *   error < 0 (behind) -> u > 0 (speed up)
 */
export class DeadbeatController {
  constructor(cfg) {
    this.tol = cfg.holdToleranceSec != null ? cfg.holdToleranceSec : 0.004;
    this.hard = cfg.hardThresholdSec;
    this.umax = cfg.maxRateAdjust;
    this.tConverge = cfg.convergeSec || 0.8;
    this.minDur = cfg.minCorrectionSec || 0.08;
  }

  /**
   * @param {number} error seconds (+ = ahead of host)
   * @returns {{type:'hold'}|{type:'reseek'}|{type:'correct',u:number,dur:number,zeroAtMs:number}}
   */
  plan(error) {
    const abs = Math.abs(error);
    if (abs <= this.tol) return { type: 'hold' };          // already ~0: don't touch
    if (abs > this.hard) return { type: 'reseek' };        // gross: jump instead
    let u = -error / this.tConverge;                       // desired deviation
    u = clamp(u, -this.umax, this.umax);                   // clamp to safe range
    if (u === 0) return { type: 'hold' };
    let dur = abs / Math.abs(u);                           // exact time to reach 0
    if (dur < this.minDur) { dur = this.minDur; u = -error / dur; } // re-solve for tiny errors
    return { type: 'correct', u, dur, zeroAtMs: dur * 1000 };
  }

  reset() {}
}

/**
 * Scheduler — decoupled periodic loop emitting 'tick'. Timer-based so it keeps
 * running when the tab is backgrounded (rAF would be throttled).
 */
export class Scheduler extends Emitter {
  constructor(intervalMs) { super(); this.interval = intervalMs; this._t = null; }
  start() { this.stop(); this._t = setInterval(() => this.emit('tick', performance.now()), this.interval); }
  stop() { if (this._t) clearInterval(this._t); this._t = null; }
  get running() { return this._t != null; }
}

/**
 * LatencyEstimator — tracks one-way delay (rtt/2) and its jitter with an
 * adaptive EMA, and recommends a scheduling lead so predictive reseeks land
 * on target despite network jitter.
 */
export class LatencyEstimator {
  constructor() { this.oneWay = 0; this.jitter = 0; this._m = 0; this._v = 0; this.n = 0; }
  update(rtt) {
    if (!isFinite(rtt) || rtt < 0) return;
    const ow = rtt / 2;
    const a = this.n < 8 ? 0.5 : 0.15;
    this.oneWay = this.n ? this.oneWay + a * (ow - this.oneWay) : ow;
    const d = ow - this._m;
    this._m += a * d;
    this._v = (1 - a) * (this._v + a * d * d);
    this.jitter = Math.sqrt(this._v);
    this.n++;
  }
  /** Recommended predictive lead in seconds (base + 2σ jitter, capped). */
  lead(baseSec) { return Math.min(0.12, (baseSec || 0) + (this.jitter * 2) / 1000); }
}

/**
 * AdaptiveResyncPolicy — debounces hard reseeks with hysteresis so a single
 * jitter spike triggers a smooth rate correction instead of an audible jump.
 * Only sustained or gross errors force a hard reseek.
 */
export class AdaptiveResyncPolicy {
  constructor(cfg) { this.hard = cfg.hardThresholdSec; this.streak = 0; this.lastReseek = 0; }
  shouldReseek(error) {
    const abs = Math.abs(error);
    const now = performance.now();
    if (abs > this.hard * 2) { this.streak = 0; this.lastReseek = now; return true; }
    if (abs > this.hard) this.streak++;
    else { this.streak = Math.max(0, this.streak - 1); return false; }
    if (this.streak >= 2 && now - this.lastReseek > 500) { this.streak = 0; this.lastReseek = now; return true; }
    return false;
  }
  reset() { this.streak = 0; }
}

/**
 * SyncHealth — rolling RMS of the playback error and a 0..1 health score, for
 * telemetry and UI feedback.
 */
export class SyncHealth {
  constructor(size = 40) { this.size = size; this.buf = []; }
  push(errorSec) { this.buf.push(errorSec * 1000); if (this.buf.length > this.size) this.buf.shift(); }
  rms() { return this.buf.length ? Math.sqrt(mean(this.buf.map((x) => x * x))) : 0; }
  score() { return clamp(1 - this.rms() / 120, 0, 1); }
  reset() { this.buf = []; }
}

/**
 * SyncEngine — guest-side orchestrator. Consumes the host-authoritative
 * timeline and the shared clock and continuously steers local playback to
 * match. Event-driven: reacts to clock/timeline updates and also runs a
 * periodic safety monitor (interval set by cfg.syncCheckMs).
 * Emits: 'status', 'timeline', 'resync'.
 */
export class SyncEngine extends Emitter {
  constructor(audio, clock, cfg) {
    super();
    this.audio = audio;
    this.clock = clock;
    this.cfg = cfg;
    this.controller = new DeadbeatController(cfg);
    this.scheduler = new Scheduler(cfg.syncCheckMs);
    this.latency = new LatencyEstimator();
    this.policy = new AdaptiveResyncPolicy(cfg);
    this.health = new SyncHealth();
    this.audio.setCorrectionRamp(cfg.rateRampSec != null ? cfg.rateRampSec : 0.03);
    this.timeline = null;   // { playing, position, atServerTime, seq }
    this.state = 'idle';    // idle | armed | locked | correcting
    this.error = 0;
    this.corrections = 0;
    this._corrEnd = 0;      // ctx-time at which the active correction returns to 0
    this.lastPlan = null;
    this.telemetry = { min: Infinity, max: -Infinity, absSum: 0, n: 0 };
    this.onStatus = null;   // compatibility callback

    this._unbind = [
      this.scheduler.on('tick', () => this._monitor()),
      this.clock.on('update', (q) => { this.latency.update(q.rtt); if (this.state !== 'idle') this._monitor(); })
    ];
  }

  /** Apply a new host timeline (ignores stale sequence numbers). */
  setTimeline(tl) {
    if (this.timeline && tl.seq != null && this.timeline.seq != null && tl.seq < this.timeline.seq) return;
    this.timeline = tl;
    this.emit('timeline', tl);
    this._align(true);
  }

  /** Expected local playback position (s) for the current shared time. */
  expectedPosition() {
    const tl = this.timeline;
    if (!tl) return 0;
    if (!tl.playing) return tl.position;
    return tl.position + (this.clock.now() - tl.atServerTime) / 1000;
  }

  start() { this.state = 'armed'; this.controller.reset(); this.policy.reset(); this.health.reset(); this._corrEnd = 0; this.scheduler.start(); this._align(true); }
  stop() { this.scheduler.stop(); this.state = 'idle'; }
  destroy() { this.stop(); this._unbind.forEach((fn) => fn()); this.clear(); }

  ready() { return !!(this.timeline && this.audio.hasAudio() && this.clock.synced); }

  /** Hard alignment: schedule playback so the HEARD audio lands on expected. */
  _align(force) {
    if (!this.ready()) return;
    const tl = this.timeline;
    if (!tl.playing) {
      this.audio.cancelCorrection();
      if (this.audio.playing) this.audio.pause();
      this.audio.seek(tl.position, false);
      this._corrEnd = 0; this.state = 'armed';
      return;
    }
    const target = this.expectedPosition();
    if (target >= this.audio.duration) { this.audio.seek(this.audio.duration, false); return; }
    if (force || !this.audio.playing) this._reseek(target);
  }

  /** Predictive reseek: schedule start so the heard position hits `target`. */
  _reseek(target) {
    const lead = this.latency.lead(this.cfg.scheduleLeadSec);
    const outLat = this.audio.outputLatency();
    this.audio.cancelCorrection();
    this.audio.setRate(1);
    const when = this.audio.ctx ? this.audio.ctx.currentTime + lead : null;
    // scheduled offset = target + lead + outputLatency  =>  heard(t) == expected(t)
    this.audio.play(target + lead + outLat, when);
    this._corrEnd = 0;
    this.state = 'locked';
    this.corrections++;
    this.emit('resync', { at: target });
  }

  _monitor() {
    if (!this.ready()) return;
    const tl = this.timeline;
    if (!tl.playing) { if (this.audio.playing) this.audio.pause(); this._report(); return; }
    if (!this.audio.playing) { this._align(true); this._report(); return; }

    const expected = this.expectedPosition();
    const heard = this.audio.position() - this.audio.outputLatency(); // what the ear hears now
    const error = heard - expected;    // + => ahead (sign preserved)
    this.error = error;
    this._track(error);

    const nowCtx = this.audio.ctx ? this.audio.ctx.currentTime : 0;

    // Policy is the single authority on hard reseeks: call it every tick (not
    // only when already over threshold) so its streak correctly decays on
    // small errors too. A brief spike over hardThresholdSec is debounced —
    // we hold steady and re-check next tick rather than jumping immediately.
    if (this.policy.shouldReseek(error)) {
      this._reseek(expected); this._report(); return;
    }
    if (Math.abs(error) > this.cfg.hardThresholdSec) {
      // Gross but not yet confirmed by hysteresis — don't touch playback rate
      // (a rate nudge can't fix a gross error anyway), just wait for the
      // next tick's confirmation or decay.
      this._report(); return;
    }
    // A deadbeat correction is in flight: let it converge to exactly 0 —
    // the drifter stays active but we do NOT change it at the zero instant.
    if (this._corrEnd > nowCtx + 0.004 && this.audio.hasCorrection()) { this._report(); return; }

    const plan = this.controller.plan(error);
    this.lastPlan = plan;
    if (plan.type === 'hold') {
      if (this.audio.rate !== 1 || this.audio.hasCorrection()) this.audio.cancelCorrection();
      this.state = 'locked';
    } else if (plan.type === 'reseek') {
      this._reseek(expected);
    } else {
      this.audio.scheduleCorrection(plan.u, plan.dur);
      this._corrEnd = nowCtx + plan.dur;
      this.corrections++;
      this.state = 'correcting';
    }
    this._report();
  }

  _track(error) {
    const a = Math.abs(error);
    const t = this.telemetry;
    t.min = Math.min(t.min, a); t.max = Math.max(t.max, a);
    t.absSum += a; t.n++;
    this.health.push(error);
  }

  _report() {
    const status = {
      error: this.error,
      corrections: this.corrections,
      state: this.state,
      rtt: this.clock.rtt,
      offset: this.clock.offset,
      jitter: this.clock.jitter,
      oneWay: this.latency.oneWay,
      health: this.health.score(),
      rms: this.health.rms(),
      correctionMs: this.lastPlan && this.lastPlan.zeroAtMs ? this.lastPlan.zeroAtMs : 0,
      avgError: this.telemetry.n ? this.telemetry.absSum / this.telemetry.n : 0
    };
    if (this.onStatus) this.onStatus(status);
    this.emit('status', status);
  }
}

// Backward-compatible alias.
export const SyncController = SyncEngine;

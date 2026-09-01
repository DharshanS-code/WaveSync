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
 * KalmanOffsetFilter — 1-D Kalman filter that fuses noisy clock-offset
 * measurements into a smooth, low-variance estimate. Measurement variance is
 * derived from RTT so high-latency samples are trusted less.
 */
export class KalmanOffsetFilter {
  constructor(processVar = 0.02) {
    this.q = processVar;   // process noise (drift of the true offset)
    this.x = 0;            // estimated offset
    this.p = 1000;         // estimate covariance
    this.init = false;
  }
  update(z, measVar) {
    const r = Math.max(1, measVar);
    if (!this.init) { this.x = z; this.p = r; this.init = true; return this.x; }
    this.p += this.q;                     // predict
    const k = this.p / (this.p + r);      // Kalman gain
    this.x += k * (z - this.x);           // correct
    this.p *= (1 - k);
    return this.x;
  }
  get value() { return this.x; }
  reset() { this.init = false; this.p = 1000; }
}

/**
 * ClockSynchronizer — estimates the offset between this device's wall clock
 * (Date.now) and the signaling server's shared GMT/UTC clock using NTP-style
 * round trips, with min-RTT anchoring, outlier rejection and EMA smoothing.
 * Emits: 'sync' (first lock since last reset), 'update' (every sample).
 */
export class ClockSynchronizer extends Emitter {
  constructor(cfg = {}) {
    super();
    this.window = cfg.clockWindow || 30;
    this.alpha = cfg.clockEmaAlpha || 0.15;
    this.offset = 0;        // serverClock - localClock (ms)
    this.rtt = Infinity;    // best (lowest) round-trip time (ms)
    this.jitter = 0;        // rtt standard deviation (ms)
    this.confidence = 0;    // 0..1 quality score
    this.synced = false;
    this._samples = [];     // { rtt, offset }
    this._minSamples = cfg.calibMinSamples || 5;
    this.kalman = new KalmanOffsetFilter(cfg.clockProcessNoise);
  }

  /** Ingest one round trip. t0 = send (local), t1 = server/remote, t2 = recv (local). Accepts optional source path tag. */
  addSample(t0, t1, t2, source = 'ws') {
    const rtt = t2 - t0;
    if (rtt < 0 || !isFinite(rtt)) return this.quality();
    const rawOffset = t1 - (t0 + t2) / 2;
    this._samples.push({ rtt, offset: rawOffset, source });
    if (this._samples.length > this.window) this._samples.shift();

    const rtts = this._samples.map((s) => s.rtt);
    const med = median(rtts);

    // Reject outlier spikes before updating Kalman state
    if (this._samples.length <= 3 || rtt <= med * 2.5 + 10) {
      const measVar = Math.max(1, (rtt * rtt) / 4); // trust low-RTT samples more
      this.offset = this.kalman.update(rawOffset, measVar);
    }

    if (!this.synced) { this.synced = true; this.emit('sync', this.quality()); }

    let best = this._samples[0];
    for (const s of this._samples) if (s.rtt < best.rtt) best = s;
    this.rtt = best.rtt;
    this.jitter = stddev(rtts);
    this.confidence = clamp(this._samples.length / this._minSamples, 0, 1) * clamp(1 - this.jitter / 150, 0, 1);

    const q = this.quality();
    this.emit('update', q);
    return q;
  }

  /** Shared server-time estimate (ms since epoch, GMT). */
  now() { return Date.now() + this.offset; }

  quality() {
    return {
      offset: this.offset, rtt: this.rtt, jitter: this.jitter,
      confidence: this.confidence, samples: this._samples.length, synced: this.synced
    };
  }

  // NOTE: deliberately does NOT touch `this.kalman` — the offset/covariance
  // estimate is preserved across a reset so a signaling reconnect doesn't
  // cause an audible re-drift while the fresh calibration burst (see
  // network.js SignalClient._startClock) re-earns confidence. Only the
  // per-connection bookkeeping (sample window, confidence, synced flag) is
  // cleared, which lets 'sync' legitimately refire once the next burst locks.
  reset() { this._samples = []; this.synced = false; this.confidence = 0; this.rtt = Infinity; }
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
 * Gross errors never reach this class: SyncEngine._monitor checks
 * `hardThresholdSec` (via AdaptiveResyncPolicy) and calls _reseek() directly
 * before plan() is ever invoked, so this controller only ever has to solve
 * the "smooth correction" case.
 *
 * Sign convention (never inverted): error = local - expected.
 *   error > 0 (ahead)  -> u < 0 (slow down)
 *   error < 0 (behind) -> u > 0 (speed up)
 */
export class DeadbeatController {
  constructor(cfg) {
    this.tol = cfg.holdToleranceSec != null ? cfg.holdToleranceSec : 0.004;
    this.umax = cfg.maxRateAdjust;
    this.tConverge = cfg.convergeSec || 0.8;
    this.minDur = cfg.minCorrectionSec || 0.08;
  }

  /**
   * @param {number} error seconds (+ = ahead of host)
   * @returns {{type:'hold'}|{type:'correct',u:number,dur:number,zeroAtMs:number}}
   */
  plan(error) {
    const abs = Math.abs(error);
    if (abs <= this.tol) return { type: 'hold' };          // already ~0: don't touch
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
 * Scheduler — decoupled periodic loop emitting 'tick'. Driven by a dedicated
 * Web Worker (falling back to setInterval) to remain unthrottled by main-thread
 * JS congestion or tab backgrounding.
 */
export class Scheduler extends Emitter {
  constructor(intervalMs) {
    super();
    this.interval = intervalMs;
    this._t = null;
    this._worker = null;
    this._last = null;
    this.jitterMs = 0;   // EMA of |actual tick gap - intended interval|
  }

  _onTick() {
    const now = performance.now();
    if (this._last !== null) {
      const gap = now - this._last;
      const dev = Math.abs(gap - this.interval);
      const a = 0.2;
      this.jitterMs = this.jitterMs ? this.jitterMs + a * (dev - this.jitterMs) : dev;
    }
    this._last = now;
    this.emit('tick', now);
  }

  start() {
    this.stop();
    this._last = performance.now();

    if (typeof Blob !== 'undefined' && typeof Worker !== 'undefined' && typeof URL !== 'undefined') {
      try {
        const code = `
          let t = null;
          self.onmessage = function(e) {
            if (e.data && e.data.action === 'start') {
              if (t) clearInterval(t);
              t = setInterval(function() { self.postMessage('tick'); }, e.data.interval);
            } else if (e.data && e.data.action === 'stop') {
              if (t) clearInterval(t);
              t = null;
            }
          };
        `;
        const blob = new Blob([code], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        this._worker = new Worker(url);
        this._worker.onmessage = () => this._onTick();
        this._worker.postMessage({ action: 'start', interval: this.interval });
        return;
      } catch (e) {
        this._worker = null;
      }
    }

    this._t = setInterval(() => this._onTick(), this.interval);
  }

  stop() {
    if (this._worker) {
      try { this._worker.postMessage({ action: 'stop' }); this._worker.terminate(); } catch (e) {}
      this._worker = null;
    }
    if (this._t) { clearInterval(this._t); this._t = null; }
    this._last = null;
  }

  get running() { return this._worker != null || this._t != null; }
}

/**
 * LatencyEstimator — tracks a round-trip's one-way component (rtt/2) and its
 * jitter with an adaptive EMA. Kept transport-agnostic on purpose: SyncEngine
 * feeds this from real WebRTC P2P ping/pong samples (see reportP2pSample),
 * distinct from ClockSynchronizer's signaling-WebSocket RTT — the two paths
 * have genuinely different latency characteristics and are surfaced as
 * separate telemetry fields (p2pRtt/p2pJitter vs clock.rtt/clock.jitter).
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
 * periodic safety monitor. Emits: 'status', 'timeline', 'resync'.
 */
export class SyncEngine extends Emitter {
  constructor(audio, clock, cfg) {
    super();
    this.audio = audio;
    this.clock = clock;
    this.cfg = cfg;
    this.controller = new DeadbeatController(cfg);
    this.scheduler = new Scheduler(cfg.syncCheckMs);
    this.latency = new LatencyEstimator();   // now fed by P2P ping/pong (see reportP2pSample), not signaling RTT
    this.policy = new AdaptiveResyncPolicy(cfg);
    this.health = new SyncHealth();
    this.timeline = null;   // { playing, position, atServerTime, seq }
    this.state = 'idle';    // idle | armed | locked | correcting
    this.error = 0;
    this.corrections = 0;
    this._corrEnd = 0;      // ctx-time at which the active correction returns to 0
    this.lastPlan = null;
    this.telemetry = { min: Infinity, max: -Infinity, absSum: 0, n: 0 };
    this.onStatus = null;   // compatibility callback

    this._onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && this.state !== 'idle') {
        // Timer throttling while hidden can let error accumulate invisibly;
        // a full realign on return is cheap insurance and avoids trying to
        // keep smooth corrections converging while backgrounded.
        this._align(true);
      }
    };
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', this._onVisible);
    }

    this._unbind = [
      this.scheduler.on('tick', () => this._monitor()),
      this.clock.on('update', () => { if (this.state !== 'idle') this._monitor(); }),
      audio.addLifecycleListener
        ? audio.addLifecycleListener((st) => {
            // 'running' = just recovered from suspend/interruption; 'closed' =
            // context was torn down (AudioEngine already dropped _playing) and
            // needs an immediate replay rather than waiting on the next
            // monitor tick to notice via the error threshold.
            if ((st === 'running' || st === 'closed') && this.state !== 'idle') this._align(true);
          })
        : () => {}
    ];
  }

  /** Feed one WebRTC P2P round-trip sample (ms) — e.g. from network.js's dcFast ping/pong. */
  reportP2pSample(rttMs) { this.latency.update(rttMs); }

  /**
   * Apply a new host timeline. Distinguishes a *routine refresh* (heartbeat —
   * update the extrapolation anchor only) from an event that actually needs
   * re-anchoring audio: first lock, a play/pause transition, a confirmed
   * discontinuity (real seek/track change), or an already-gross error. Fixes
   * H1: previously every heartbeat forced a hard reseek (stop+restart of the
   * AudioBufferSourceNode), which is an audible dropout every
   * `timelineHeartbeatMs` regardless of whether anything actually changed.
   */
  setTimeline(tl) {
    if (this.timeline && tl.seq != null && this.timeline.seq != null && tl.seq < this.timeline.seq) return;
    const prev = this.timeline;
    const isFirst = !prev;
    const transportChanged = !isFirst && prev.playing !== tl.playing;
    let discontinuous = isFirst || transportChanged;
    if (!discontinuous && prev.playing && tl.playing) {
      const predicted = prev.position + (tl.atServerTime - prev.atServerTime) / 1000;
      const tol = this.cfg.discontinuityToleranceSec != null ? this.cfg.discontinuityToleranceSec : 0.08;
      discontinuous = Math.abs(predicted - tl.position) > tol;
    }
    this.timeline = tl;
    this.emit('timeline', tl);
    this._align(isFirst || transportChanged || discontinuous);
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
  destroy() {
    this.stop();
    this._unbind.forEach((fn) => fn());
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('visibilitychange', this._onVisible);
    }
    this.clear();
  }

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

  /**
   * Predictive scheduling lead (s): how far in the future to schedule
   * playback so the browser's actual `.play()` execution — not network
   * transit — lands on target. Driven by measured LOCAL scheduling jitter
   * (Scheduler's tick-interval drift), not signaling RTT (fixes H2 part 1:
   * signaling-server RTT can be low even while a busy/backgrounded main
   * thread makes local scheduling unreliable, and vice versa). Backgrounded
   * tabs get an explicit floor since timer throttling there is large and
   * abrupt — an EMA can't anticipate it.
   */
  _computeLead() {
    const base = this.cfg.scheduleLeadSec || 0.02;
    const jitterSec = (this.scheduler.jitterMs || 0) / 1000;
    const mult = this.cfg.leadJitterMultiplier != null ? this.cfg.leadJitterMultiplier : 3;
    const cap = this.cfg.maxLeadSec != null ? this.cfg.maxLeadSec : 0.5;
    let lead = base + jitterSec * mult;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden) {
      const floor = this.cfg.backgroundLeadFloorSec != null ? this.cfg.backgroundLeadFloorSec : 0.35;
      lead = Math.max(lead, floor);
    }
    return Math.min(cap, lead);
  }

  /** Predictive reseek: schedule start so the heard position hits `target`. */
  _reseek(target) {
    const lead = this._computeLead();
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

    // Gross error (host seek / stall) overrides everything.
    if (Math.abs(error) > this.cfg.hardThresholdSec && this.policy.shouldReseek(error)) {
      // Guard against scheduling a reseek past end-of-track (minor finding:
      // _align already had this guard, _monitor's own reseek path didn't).
      if (expected >= this.audio.duration) { this.audio.seek(this.audio.duration, false); this._report(); return; }
      this._reseek(expected); this._report(); return;
    }
    // A deadbeat correction is in flight: let it converge to exactly 0 —
    // the drifter stays active but we do NOT change it at the zero instant.
    if (this._corrEnd > nowCtx + 0.004 && this.audio.hasCorrection()) { this._report(); return; }

    const plan = this.controller.plan(error);
    this.lastPlan = plan;
    if (plan.type === 'hold') {
      if (this.audio.rate !== 1 || this.audio.hasCorrection()) this.audio.cancelCorrection();
      this.state = 'locked';
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
      p2pRtt: this.latency.oneWay * 2,
      p2pJitter: this.latency.jitter,
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

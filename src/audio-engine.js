// audio-engine.js — Web Audio decode + sample-accurate scheduled playback.
// Shared by host and guest. Position is derived from AudioContext.currentTime
// so it is immune to setInterval/timer jitter.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;      // decoded AudioBuffer
    this.source = null;      // active AudioBufferSourceNode
    this._startCtx = 0;      // ctx.currentTime when current source started
    this._startOffset = 0;   // buffer offset (s) at start / last known position
    this._rate = 1;
    this._playing = false;
    this.duration = 0;
    this.onEnded = null;
    this._corr = null;       // active deadbeat correction segment
    this.normGain = 1;       // loudness-normalization gain
    this._userVol = 1;       // user volume 0..1
    this._latencyOffsetSec = 0; // manual per-device calibration offset (see setLatencyOffset)
    this._lifecycleListeners = [];
    this._wasPlayingBeforeSuspend = false;
  }

  _ensure() {
    // Recreate if we've never had a context, OR if the previous one was
    // closed out from under us (e.g. mobile Safari after a phone-call
    // interruption). Previously this only checked `!this.ctx`, so a closed
    // context was never replaced and the engine stayed silently dead.
    if (!this.ctx || this.ctx.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this._applyGain();
      this.ctx.onstatechange = () => {
        const st = this.ctx.state;
        if (st === 'closed' && this._playing) {
          // The context was torn down out from under us (e.g. an iOS
          // interruption). Freeze position at the last known instant instead
          // of leaving `_playing` true against a dead context — that would
          // make position() read a stale/frozen currentTime indefinitely.
          this._startOffset = this.position();
          this._playing = false;
          this.source = null;
        }
        this._fireLifecycle(st);
      };
    }
  }

  /** Subscribe to AudioContext lifecycle changes ('running'|'suspended'|'closed'|'interrupted').
   *  Returns an unsubscribe function. Used by SyncEngine to trigger a full
   *  realign once audio becomes live again after a suspension/interruption. */
  addLifecycleListener(fn) {
    this._lifecycleListeners.push(fn);
    return () => { this._lifecycleListeners = this._lifecycleListeners.filter((f) => f !== fn); };
  }

  _fireLifecycle(state) {
    for (const fn of this._lifecycleListeners) { try { fn(state); } catch (e) {} }
  }

  async resume() {
    this._ensure();
    if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
      try { await this.ctx.resume(); } catch (e) {}
    }
  }

  async decode(arrayBuffer) {
    this._ensure();
    const buf = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this._setActiveBuffer(buf);
    return this.duration;
  }

  // Decode without swapping the active buffer (used to preload queued tracks).
  async decodeToBuffer(arrayBuffer) {
    this._ensure();
    return this.ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  setBuffer(buf) { this._setActiveBuffer(buf); }

  _setActiveBuffer(buf) {
    this.buffer = buf;
    this.duration = buf ? buf.duration : 0;
    this.normGain = buf ? this._computeNorm(buf) : 1;
    this._applyGain();
  }

  // Loudness (RMS) normalization so louder tracks/devices don't dominate.
  _computeNorm(buf, target = 0.14) {
    let sum = 0, n = 0;
    const step = Math.max(1, Math.floor(buf.length / 40000));
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i += step) { sum += d[i] * d[i]; n++; }
    }
    const rms = Math.sqrt(sum / Math.max(1, n));
    const g = rms > 1e-4 ? target / rms : 1;
    return Math.min(4, Math.max(0.25, g));
  }

  _applyGain() { if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, this._userVol)) * this.normGain; }

  hasAudio() { return !!this.buffer; }

  setVolume(v) { this._ensure(); this._userVol = Math.max(0, Math.min(1, v)); this._applyGain(); }
  get volume() { return this._userVol; }

  get playing() { return this._playing; }
  get rate() { return this._rate; }
  hasCorrection() { return !!this._corr; }

  /**
   * Manual per-device latency calibration (mitigation for H3): Bluetooth
   * transport/codec latency (commonly 100-300ms, device-dependent) is not
   * visible to the Web Audio API on any browser, so `outputLatency()` is
   * systematically wrong on Bluetooth output no matter how correct the rest
   * of the sync math is. This lets a "sounds early/late" UI control nudge
   * the estimate. Signed seconds: positive means this device's true output
   * delay is LARGER than what the API reports (audio is heard later than
   * assumed) — increase it if this device sounds behind the others, decrease
   * (or use a negative value) if it sounds ahead. This file intentionally
   * does not persist the value — the caller (UI) should do that, e.g. via
   * localStorage keyed by output device if that's discoverable.
   */
  setLatencyOffset(sec) {
    this._latencyOffsetSec = clampNum(Number(sec) || 0, -0.5, 0.5);
  }
  getLatencyOffset() { return this._latencyOffsetSec; }

  /** Output latency (s): delay between scheduling a sample and hearing it.
   *  Uses AudioContext.getOutputTimestamp() when available for dynamic latency
   *  calculation, falling back to ctx.outputLatency / ctx.baseLatency. */
  outputLatency() {
    if (!this.ctx) return this._latencyOffsetSec;
    let base = 0;
    if (typeof this.ctx.getOutputTimestamp === 'function') {
      try {
        const ts = this.ctx.getOutputTimestamp();
        if (ts && typeof ts.contextTime === 'number' && ts.contextTime >= 0 && typeof ts.performanceTime === 'number' && ts.performanceTime > 0) {
          const dtSec = (performance.now() - ts.performanceTime) / 1000;
          const currentOutputContextTime = ts.contextTime + dtSec;
          const dynLatency = this.ctx.currentTime - currentOutputContextTime;
          if (dynLatency >= 0 && isFinite(dynLatency)) {
            base = dynLatency;
          }
        }
      } catch (e) {}
    }
    if (!base) {
      const o = this.ctx.outputLatency, b = this.ctx.baseLatency;
      if (typeof o === 'number' && o > 0) base = o;
      else if (typeof b === 'number' && b > 0) base = b;
    }
    return base + this._latencyOffsetSec;
  }

  _clampPos(p) { return Math.max(0, Math.min(this.duration, p)); }

  // Scheduled playback position (s), accounting for an in-flight deadbeat
  // correction segment (piecewise-constant rate). Lazily collapses a finished
  // correction back into the steady rate-1 model.
  position() {
    if (!this.buffer) return 0;
    if (!this._playing) return this._startOffset;
    const t = this.ctx.currentTime;
    const c = this._corr;
    if (c) {
      if (t <= c.t0) return this._clampPos(c.pos0);
      if (t < c.t0 + c.dur) return this._clampPos(c.pos0 + c.rate * (t - c.t0));
      const endPos = c.pos0 + c.rate * c.dur;   // correction finished
      this._startCtx = c.t0 + c.dur;
      this._startOffset = endPos;
      this._rate = 1;
      this._corr = null;
      return this._clampPos(endPos + (t - this._startCtx));
    }
    return this._clampPos(this._startOffset + (t - this._startCtx) * this._rate);
  }

  _newSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.playbackRate.value = this._rate;
    s.connect(this.gain);
    s.onended = () => {
      if (this.source === s && this._playing && this.position() >= this.duration - 0.05) {
        this._playing = false;
        this._startOffset = this.duration;
        if (this.onEnded) this.onEnded();
      }
    };
    return s;
  }

  _stopSource() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch (e) {}
      try { this.source.disconnect(); } catch (e) {}
      this.source = null;
    }
  }

  // Start playback at buffer `offset`, optionally scheduled at ctx-time `when`.
  play(offset = null, when = null) {
    if (!this.buffer) return;
    this._ensure();
    if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') this.ctx.resume();
    let off = offset != null ? offset : this.position();
    // Clamp with a small safety margin before the true end, rather than
    // exactly at `duration`: starting a source with ~0 samples left produces
    // an audible click and an onended firing almost immediately.
    const EPS = 0.05;
    const safeEnd = this.duration > EPS ? this.duration - EPS : this.duration;
    off = Math.max(0, Math.min(safeEnd, off));
    this._stopSource();
    const w = when != null ? Math.max(this.ctx.currentTime, when) : this.ctx.currentTime;
    const s = this._newSource();
    s.start(w, off);
    this.source = s;
    this._startCtx = w;
    this._startOffset = off;
    this._playing = true;
    this._corr = null;
  }

  // Deadbeat correction: run at rate (1+u) and return to exactly 1 after
  // `duration` seconds, scheduled sample-accurately on the AudioParam so the
  // error crosses 0 precisely at t0+duration and then stays put.
  scheduleCorrection(u, duration) {
    if (!this.source || !this._playing || !(duration > 0)) return;
    const now = this.ctx.currentTime;
    const pos0 = this.position();            // snapshot (collapses any prior corr)
    const rate = 1 + u;
    const pr = this.source.playbackRate;
    try {
      pr.cancelScheduledValues(now);
      pr.setValueAtTime(rate, now);
      pr.setValueAtTime(1, now + duration);  // exact, sample-accurate drop to 1
    } catch (e) {}
    this._corr = { t0: now, pos0, rate, dur: duration };
    this._rate = 1;                          // steady rate resumes after the window
  }

  cancelCorrection() {
    if (!this._corr) return;
    const pos = this.position();             // collapses to current position
    if (this.source) {
      try {
        const pr = this.source.playbackRate;
        pr.cancelScheduledValues(this.ctx.currentTime);
        pr.setValueAtTime(1, this.ctx.currentTime);
      } catch (e) {}
    }
    this._startCtx = this.ctx.currentTime;
    this._startOffset = pos;
    this._rate = 1;
    this._corr = null;
  }

  pause() {
    if (!this._playing) return;
    const pos = this.position();
    this._stopSource();
    this._startOffset = pos;
    this._playing = false;
    this._corr = null;
  }

  seek(offset, keepPlaying) {
    const off = Math.max(0, Math.min(this.duration, offset));
    if (keepPlaying && this.buffer) {
      this.play(off);
    } else {
      this._stopSource();
      this._startOffset = off;
      this._playing = false;
      this._corr = null;
    }
  }

  // Immediate rate override (cancels any scheduled correction).
  setRate(r) {
    if (!this.buffer) { this._rate = r; return; }
    const pos = this.position();
    if (this._corr && this.source) {
      try { this.source.playbackRate.cancelScheduledValues(this.ctx.currentTime); } catch (e) {}
      this._corr = null;
    }
    this._rate = r;
    if (this.source && this._playing) {
      this._startOffset = pos;
      this._startCtx = this.ctx.currentTime;
      try { this.source.playbackRate.value = r; } catch (e) {}
    }
  }
}

function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

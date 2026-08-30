// audio-engine.js — Web Audio decode + sample-accurate scheduled playback.
// Shared by host and guest. Position is derived from AudioContext.currentTime
// so it is immune to setInterval/timer jitter.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
    this._corr = null;       // active deadbeat correction segment (trapezoid shape)
    this._rampSec = 0.03;    // ramp-in/out time for corrections (smooths the pitch transition)
    this.normGain = 1;       // loudness-normalization gain
    this._userVol = 1;       // user volume 0..1
  }

  /** Configure how long a correction's rate ramps in/out (seconds). */
  setCorrectionRamp(sec) { this._rampSec = Math.max(0, sec || 0); }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
  }

  async resume() {
    this._ensure();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) {} }
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

  /** Output latency (s): delay between scheduling a sample and hearing it. */
  outputLatency() {
    if (!this.ctx) return 0;
    const o = this.ctx.outputLatency, b = this.ctx.baseLatency;
    if (typeof o === 'number' && o > 0) return o;
    if (typeof b === 'number' && b > 0) return b;
    return 0;
  }

  _clampPos(p) { return Math.max(0, Math.min(this.duration, p)); }

  // Scheduled playback position (s), accounting for an in-flight deadbeat
  // correction segment. The correction is a trapezoid (ramp-in / hold /
  // ramp-out) rather than a rectangular step, so this integrates the actual
  // rate curve rather than assuming a constant rate during the correction.
  // Lazily collapses a finished correction back into the steady rate-1 model.
  position() {
    if (!this.buffer) return 0;
    if (!this._playing) return this._startOffset;
    const t = this.ctx.currentTime;
    const c = this._corr;
    if (c) {
      const tau = t - c.t0;
      if (tau <= 0) return this._clampPos(c.pos0);
      if (tau < c.dur) return this._clampPos(c.pos0 + this._corrDistance(c, tau));
      const endPos = c.pos0 + this._corrDistance(c, c.dur);  // correction finished
      this._startCtx = c.t0 + c.dur;
      this._startOffset = endPos;
      this._rate = 1;
      this._corr = null;
      return this._clampPos(endPos + (t - this._startCtx));
    }
    return this._clampPos(this._startOffset + (t - this._startCtx) * this._rate);
  }

  // Distance traveled `tau` seconds into a trapezoid correction segment c
  // ({ up, rampT, holdT }): rate ramps linearly 1 -> 1+up over rampT, holds
  // at 1+up for holdT, then ramps linearly back down to 1 over rampT. This
  // is the exact integral of that piecewise-linear rate curve.
  _corrDistance(c, tau) {
    const { up, rampT, holdT } = c;
    if (rampT <= 1e-9) return (1 + up) * tau; // degenerate: no ramp, pure rectangle
    if (tau <= rampT) {
      return tau + (up * tau * tau) / (2 * rampT);
    }
    const distRampIn = rampT + (up * rampT) / 2;
    if (tau <= rampT + holdT) {
      return distRampIn + (1 + up) * (tau - rampT);
    }
    const distHold = distRampIn + (1 + up) * holdT;
    const s = tau - rampT - holdT; // time into the ramp-out, in [0, rampT]
    return distHold + (1 + up) * s - (up * s * s) / (2 * rampT);
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
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const off = Math.max(0, Math.min(this.duration, offset != null ? offset : this.position()));
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

  // Deadbeat correction: ramp smoothly to rate (1+u), hold, then ramp back to
  // exactly 1 after `duration` seconds — scheduled sample-accurately on the
  // AudioParam so the error crosses 0 precisely at t0+duration and stays put.
  // Shaped as a trapezoid (not a rectangular step) so there is no instant
  // pitch jump at the start/end of a correction — that discontinuity was the
  // actual source of the audible "flutter" on every correction.
  scheduleCorrection(u, duration) {
    if (!this.source || !this._playing || !(duration > 0)) return;
    const now = this.ctx.currentTime;
    const pos0 = this.position();            // snapshot (collapses any prior corr)

    const rampT = Math.min(this._rampSec, duration / 2);
    const holdT = Math.max(0, duration - 2 * rampT);
    // A trapezoid covers less area than a rectangle of the same peak height
    // (the ramps are triangular, not full-height) — compensate the peak so
    // the total corrected distance still equals u*duration exactly, matching
    // what the deadbeat controller computed to close the current error.
    const areaFactor = duration - rampT;
    const up = areaFactor > 1e-6 ? clamp(u * duration / areaFactor, -0.5, 0.5) : u;
    const peakRate = 1 + up;

    const pr = this.source.playbackRate;
    try {
      pr.cancelScheduledValues(now);
      pr.setValueAtTime(1, now);
      pr.linearRampToValueAtTime(peakRate, now + rampT);
      if (holdT > 0) pr.setValueAtTime(peakRate, now + rampT + holdT);
      pr.linearRampToValueAtTime(1, now + duration);  // exact, sample-accurate return to 1
    } catch (e) {}
    this._corr = { t0: now, pos0, up, rampT, holdT, dur: duration };
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

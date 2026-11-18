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
    this._sources = new Set();
    this._generation = 0;
    this._stopTimes = new WeakMap();
    this._channelMode = 'off';
    this._effectiveChannelMode = 'off';
    this._channelSupported = null;
    this._channelSplitter = null;
    this._channelMerger = null;
    this._channelGains = null;
    this._outputDeviceId = null;
    this._appliedOutputDeviceId = null;
  }

  _ensure() {
    // Recreate if we've never had a context, OR if the previous one was
    // closed out from under us (e.g. mobile Safari after a phone-call
    // interruption). Previously this only checked `!this.ctx`, so a closed
    // context was never replaced and the engine stayed silently dead.
    if (!this.ctx || this.ctx.state === 'closed') {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext ||
        globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not supported in this browser.');
      if (this.ctx) {
        this._disconnectChannelGraph();
        try { this.gain?.disconnect(); } catch { /* Closed context. */ }
        this._channelSupported = null;
        this._appliedOutputDeviceId = null;
      }
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this._buildChannelGraph();
      this._applyGain();
      this._applyChannelMode(false);
      this._applyOutputDevice().catch(() => {});
      this.ctx.onstatechange = () => {
        const st = this.ctx.state;
        if (st !== 'running' && this._playing) {
          // The context was torn down out from under us (e.g. an iOS
          // interruption). Freeze position at the last known instant instead
          // of leaving `_playing` true against a dead context — that would
          // make position() read a stale/frozen currentTime indefinitely.
          this._startOffset = this.position();
          this._stopSource();
          this._playing = false;
          this._corr = null;
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
      await this.ctx.resume();
      if (this.ctx.state !== 'running') throw new Error('Tap Enable audio to allow playback on this device.');
    }
  }

  async decode(arrayBuffer) {
    this._ensure();
    const generation = ++this._generation;
    const buf = await this.decodeToBuffer(arrayBuffer);
    if (generation !== this._generation) throw new Error('Audio selection was superseded.');
    this._setActiveBuffer(buf);
    return this.duration;
  }

  // Decode without swapping the active buffer (used to preload queued tracks).
  async decodeToBuffer(arrayBuffer) {
    this._ensure();
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength > 32 * 1024 * 1024) {
      throw new Error('Select an audio file no larger than 32 MiB.');
    }
    const buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 ||
        buffer.length * buffer.numberOfChannels * 4 > 128 * 1024 * 1024) {
      throw new Error('Decoded audio exceeds the 128 MiB per-track memory budget.');
    }
    return buffer;
  }

  setBuffer(buf) { this._setActiveBuffer(buf); }

  _setActiveBuffer(buf) {
    this._stopSource();
    this._playing = false;
    this._startOffset = 0;
    this._startCtx = this.ctx?.currentTime || 0;
    this._rate = 1;
    this._corr = null;
    this.buffer = buf;
    this.duration = buf ? buf.duration : 0;
    this.normGain = buf ? this._computeNorm(buf) : 1;
    this._applyGain();
    this._applyChannelMode(false);
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

  /**
   * Local channel filtering. Stereo left/right selects that input channel and
   * duplicates it to both output channels; off preserves the original stereo.
   * Mono always follows the original mono path so selecting either side cannot
   * mute a mono track. The setter is deliberately lazy and never creates audio.
   */
  setChannelMode(mode) {
    if (mode !== 'left' && mode !== 'right' && mode !== 'off') {
      throw new TypeError("Channel mode must be 'left', 'right', or 'off'.");
    }
    this._channelMode = mode;
    this._applyChannelMode(true);
  }

  get channelMode() { return this._channelMode; }

  get channelCapability() {
    if (this._channelSupported != null) return this._channelSupported;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext ||
      globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
    return !!(AC?.prototype?.createChannelSplitter && AC?.prototype?.createChannelMerger);
  }
  get supportsChannelSelection() { return this.channelCapability; }

  _buildChannelGraph() {
    this._disconnectChannelGraph();
    const ctx = this.ctx;
    if (!ctx) return;
    this.gain.connect(ctx.destination);
    if (typeof ctx.createChannelSplitter !== 'function' ||
        typeof ctx.createChannelMerger !== 'function') {
      this._channelSupported = false;
      return;
    }
    try {
      this._channelSplitter = ctx.createChannelSplitter(2);
      this._channelMerger = ctx.createChannelMerger(2);
      this._channelLeftGain = ctx.createGain();
      this._channelRightCancelGain = ctx.createGain();
      this._channelLeftCancelGain = ctx.createGain();
      this._channelRightGain = ctx.createGain();
      this._channelGains = [this._channelLeftGain, this._channelRightCancelGain,
        this._channelLeftCancelGain, this._channelRightGain];
      this.gain.connect(this._channelSplitter);
      this._channelSplitter.connect(this._channelLeftGain, 0);
      this._channelSplitter.connect(this._channelRightCancelGain, 1);
      this._channelSplitter.connect(this._channelLeftCancelGain, 0);
      this._channelSplitter.connect(this._channelRightGain, 1);
      this._channelLeftGain.connect(this._channelMerger, 0, 1);
      this._channelRightCancelGain.connect(this._channelMerger, 0, 1);
      this._channelLeftCancelGain.connect(this._channelMerger, 0, 0);
      this._channelRightGain.connect(this._channelMerger, 0, 0);
      this._channelMerger.connect(ctx.destination);
      this._channelSupported = true;
    } catch {
      this._disconnectChannelGraph();
      try {
        this.gain.disconnect();
        this.gain.connect(ctx.destination);
      } catch { /* The context itself is unusable; playback will fail normally. */ }
      this._channelSupported = false;
    }
  }

  _disconnectChannelGraph() {
    for (const node of [this._channelSplitter, ...(this._channelGains || []), this._channelMerger]) {
      try { node?.disconnect(); } catch { /* Node may already be detached. */ }
    }
    this._channelSplitter = null;
    this._channelMerger = null;
    this._channelLeftGain = null;
    this._channelRightCancelGain = null;
    this._channelLeftCancelGain = null;
    this._channelRightGain = null;
    this._channelGains = null;
  }

  _applyChannelMode(ramp) {
    const stereo = !!this.buffer && this.buffer.numberOfChannels > 1;
    const effective = stereo && this._channelSupported ? this._channelMode : 'off';
    this._effectiveChannelMode = effective;
    if (!this._channelGains || !this.ctx) return;
    const now = this.ctx.currentTime;
    const end = now + (ramp ? 0.02 : 0);
    // The unchanged direct path remains audible. The matrix adds the selected
    // side to its opposite output and phase-cancels the unselected side there:
    // left => [L,L], right => [R,R], off => [L,R].
    const values = effective === 'left' ? [1, -1, 0, 0]
      : effective === 'right' ? [0, 0, -1, 1] : [0, 0, 0, 0];
    for (let i = 0; i < this._channelGains.length; i++) {
      const param = this._channelGains[i].gain;
      try {
        if (ramp && typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
        else param.cancelScheduledValues?.(now);
        if (ramp && typeof param.linearRampToValueAtTime === 'function') {
          param.linearRampToValueAtTime(values[i], end);
        } else {
          param.setValueAtTime?.(values[i], now);
          if (!param.setValueAtTime) param.value = values[i];
        }
      } catch { param.value = values[i]; }
    }
  }

  _connectSource(source) {
    // Keep the historical source -> gain connection for every mode. Channel
    // selection happens after gain, so mode changes never reconnect a live
    // source and therefore cannot restart it or disturb scheduler timing.
    source.connect(this.gain);
  }

  get outputDeviceCapability() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext ||
      globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
    return !!AC?.prototype?.setSinkId;
  }

  async setOutputDevice(deviceId) {
    if (typeof deviceId !== 'string') throw new TypeError('Output device ID must be a string.');
    this._outputDeviceId = deviceId;
    if (!this.ctx) return false;
    return this._applyOutputDevice();
  }

  async _applyOutputDevice() {
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return false;
    if (this._outputDeviceId == null || this._appliedOutputDeviceId === this._outputDeviceId) return true;
    await this.ctx.setSinkId(this._outputDeviceId);
    this._appliedOutputDeviceId = this._outputDeviceId;
    return true;
  }

  hasAudio() { return !!this.buffer; }

  setVolume(v) { this._userVol = Math.max(0, Math.min(1, v)); this._applyGain(); }
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

  /** Output latency (s): delay between scheduling a sample and hearing it. */
  outputLatency() {
    if (!this.ctx) return this._latencyOffsetSec;
    const o = this.ctx.outputLatency, b = this.ctx.baseLatency;
    let base = 0;
    if (typeof o === 'number' && o > 0) base = o;
    else if (typeof b === 'number' && b > 0) base = b;
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
    return this._clampPos(this._startOffset + Math.max(0, t - this._startCtx) * this._rate);
  }

  audiblePosition() {
    if (!this._playing) return this.position();
    const mapping = this.outputMapping();
    const outputContextNow = mapping.contextTime + (performance.now() - mapping.performanceTime) / 1000;
    const delay = Math.max(0, this.ctx.currentTime - outputContextNow) + this._latencyOffsetSec;
    return this._clampPos(this.position() - delay);
  }

  _newSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.playbackRate.value = this._rate;
    this._connectSource(s);
    this._sources.add(s);
    s.onended = () => {
      this._sources.delete(s);
      s.disconnect();
      if (this.source === s && this._playing) {
        this.source = null;
        this._playing = false;
        this._startOffset = this.duration;
        this._corr = null;
        if (this.onEnded) this.onEnded();
      }
    };
    return s;
  }

  _stopSource() {
    for (const source of this._sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect();
    }
    this._sources.clear();
    this.source = null;
  }

  clear() {
    ++this._generation;
    this._setActiveBuffer(null);
  }

  async dispose() {
    this.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this._disconnectChannelGraph();
    this.gain?.disconnect();
    this.gain = null;
    this._channelSupported = null;
    this._effectiveChannelMode = 'off';
    this._appliedOutputDeviceId = null;
    if (ctx) {
      ctx.onstatechange = null;
      if (ctx.state !== 'closed') await ctx.close();
    }
    this._lifecycleListeners = [];
  }

  /** Output mapping is an implementation estimate, not measured acoustic latency. */
  outputMapping() {
    const ctx = this.ctx;
    if (ctx?.getOutputTimestamp) {
      const stamp = ctx.getOutputTimestamp();
      if (Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime) &&
          stamp.performanceTime > 0 && Math.abs(performance.now() - stamp.performanceTime) < 1000) {
        return { contextTime: stamp.contextTime, performanceTime: stamp.performanceTime,
          source: 'output-timestamp', estimated: true };
      }
    }
    return { contextTime: ctx?.currentTime || 0,
      performanceTime: performance.now() + this.outputLatency() * 1000,
      source: ctx ? 'latency-estimate' : 'unavailable', estimated: true };
  }

  // Start playback at buffer `offset`, optionally scheduled at ctx-time `when`.
  play(offset = null, when = null) {
    if (!this.buffer) return;
    this._ensure();
    if (this.ctx.state !== 'running') throw new Error('Tap Enable audio before playback.');
    let off = offset != null ? offset : this.position();
    // Clamp with a small safety margin before the true end, rather than
    // exactly at `duration`: starting a source with ~0 samples left produces
    // an audible click and an onended firing almost immediately.
    const EPS = 0.05;
    const safeEnd = this.duration > EPS ? this.duration - EPS : this.duration;
    off = Math.max(0, Math.min(safeEnd, off));
    const w = when != null ? Math.max(this.ctx.currentTime, when) : this.ctx.currentTime;
    const previous = this.source;
    if (previous && this._playing && w > this.ctx.currentTime) {
      // Keep the old source audible until the scheduled same-track handoff.
      for (const source of this._sources) {
        const stopAt = Math.min(w, this._stopTimes.get(source) ?? Infinity);
        source.stop(stopAt);
        this._stopTimes.set(source, stopAt);
      }
    } else {
      this._stopSource();
    }
    this._rate = 1;
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
    if (!this.source || !this._playing || !(duration > 0) || this.ctx.currentTime < this._startCtx) return;
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
    if (!this._playing) { this._stopSource(); return; }
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

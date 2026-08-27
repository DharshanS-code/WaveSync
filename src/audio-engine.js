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
  }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'playback' });
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
    // decodeAudioData consumes the buffer; pass a copy so callers can reuse it.
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.duration = this.buffer.duration;
    return this.duration;
  }

  hasAudio() { return !!this.buffer; }

  setVolume(v) { this._ensure(); this.gain.gain.value = Math.max(0, Math.min(1, v)); }
  get volume() { return this.gain ? this.gain.gain.value : 1; }

  get playing() { return this._playing; }
  get rate() { return this._rate; }

  position() {
    if (!this.buffer) return 0;
    if (!this._playing) return this._startOffset;
    const p = this._startOffset + (this.ctx.currentTime - this._startCtx) * this._rate;
    return Math.max(0, Math.min(this.duration, p));
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
  }

  pause() {
    if (!this._playing) return;
    const pos = this.position();
    this._stopSource();
    this._startOffset = pos;
    this._playing = false;
  }

  seek(offset, keepPlaying) {
    const off = Math.max(0, Math.min(this.duration, offset));
    if (keepPlaying && this.buffer) {
      this.play(off);
    } else {
      this._stopSource();
      this._startOffset = off;
      this._playing = false;
    }
  }

  // Smoothly change playbackRate while preserving current position baseline.
  setRate(r) {
    if (!this.buffer) { this._rate = r; return; }
    const pos = this.position();
    this._rate = r;
    if (this.source && this._playing) {
      this._startOffset = pos;
      this._startCtx = this.ctx.currentTime;
      try { this.source.playbackRate.value = r; } catch (e) {}
    }
  }
}

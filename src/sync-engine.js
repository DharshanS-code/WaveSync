// sync-engine.js — shared clock (NTP-style) + host-authoritative drift control.

// ClockSync: estimates offset between this device's Date.now() and the
// signaling server's GMT/UTC clock, using round-trip samples. Picks the
// sample with the lowest RTT (least jitter) as the truth.
export class ClockSync {
  constructor() {
    this.offset = 0;        // serverClock - localClock (ms)
    this.rtt = Infinity;    // best round-trip time (ms)
    this.samples = [];
    this.synced = false;
  }

  addSample(t0, t1, t2) {
    const rtt = t2 - t0;
    const offset = t1 - (t0 + t2) / 2; // server time minus local mid-point
    this.samples.push({ rtt, offset });
    if (this.samples.length > 25) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rtt = best.rtt;
    this.synced = true;
    return { offset: this.offset, rtt: this.rtt };
  }

  now() { return Date.now() + this.offset; } // shared GMT time estimate (ms)
}

// SyncController: guest-side. Holds the host timeline and continuously nudges
// local playback so the guest's position matches the host's authoritative
// position on the shared clock.
export class SyncController {
  constructor(audio, clock, cfg) {
    this.audio = audio;
    this.clock = clock;
    this.cfg = cfg;
    this.timeline = null;      // { playing, position, atServerTime, seq }
    this.timer = null;
    this.error = 0;            // last measured error (s), + = ahead of host
    this.corrections = 0;
    this.onStatus = null;
  }

  // { playing, position, atServerTime, seq }
  setTimeline(tl) {
    if (this.timeline && tl.seq != null && tl.seq < this.timeline.seq) return;
    this.timeline = tl;
    this._apply(true);
  }

  expectedPosition() {
    const tl = this.timeline;
    if (!tl) return 0;
    if (!tl.playing) return tl.position;
    const dt = (this.clock.now() - tl.atServerTime) / 1000;
    return tl.position + dt;
  }

  _apply(forceReseek) {
    const tl = this.timeline;
    if (!tl || !this.audio.hasAudio() || !this.clock.synced) return;
    if (!tl.playing) { if (this.audio.playing) this.audio.pause(); this.audio.seek(tl.position, false); return; }
    const target = this.expectedPosition();
    if (target >= this.audio.duration) { this.audio.seek(this.audio.duration, false); return; }
    if (forceReseek || !this.audio.playing) {
      this.audio.setRate(1);
      this.audio.play(target);
    }
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this._tick(), this.cfg.syncCheckMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  _tick() {
    const tl = this.timeline;
    if (!tl || !this.audio.hasAudio() || !this.clock.synced) return;

    if (!tl.playing) {
      if (this.audio.playing) this.audio.pause();
      this._report();
      return;
    }
    if (!this.audio.playing) { this._apply(true); return; }

    const expected = this.expectedPosition();
    const actual = this.audio.position();
    const err = actual - expected;      // + => local is ahead of host
    this.error = err;
    const abs = Math.abs(err);

    if (abs > this.cfg.hardThresholdSec) {
      // Too far off — hard resync.
      this.audio.setRate(1);
      this.audio.play(expected);
      this.corrections++;
    } else if (abs > this.cfg.softThresholdSec) {
      // Smoothly converge: slow down if ahead, speed up if behind.
      const adj = Math.max(-this.cfg.maxRateAdjust, Math.min(this.cfg.maxRateAdjust, err));
      this.audio.setRate(1 - adj);
    } else if (this.audio.rate !== 1) {
      this.audio.setRate(1);
    }
    this._report();
  }

  _report() {
    if (this.onStatus) {
      this.onStatus({
        error: this.error,
        corrections: this.corrections,
        rtt: this.clock.rtt,
        offset: this.clock.offset
      });
    }
  }
}

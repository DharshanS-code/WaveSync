import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/audio-engine.js';

class Param {
  value = 1;
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
}
class Source {
  playbackRate = new Param();
  stops = [];
  connect() {}
  disconnect() { this.disconnected = true; }
  start(when, offset) { this.started = { when, offset }; }
  stop(when) { this.stops.push(when); }
}
class Context {
  currentTime = 10;
  state = 'running';
  baseLatency = 0.01;
  outputLatency = 0.02;
  destination = {};
  sources = [];
  createGain() { return { gain: new Param(), connect() {}, disconnect() {} }; }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
globalThis.window = { AudioContext: Context };
const buffer = (duration = 60) => ({ duration, length: duration * 100, numberOfChannels: 1,
  getChannelData: () => new Float32Array(duration * 100).fill(0.1) });
function setup() { const audio = new AudioEngine(); audio.setBuffer(buffer()); audio.play(0); return audio; }

test('activating a new track stops the previous source and resets position', () => {
  const audio = setup();
  const previous = audio.source;
  audio.ctx.currentTime += 8;
  audio.setBuffer(buffer(30));
  assert.equal(audio.playing, false);
  assert.equal(audio.position(), 0);
  assert.equal(audio.source, null);
  assert.ok(previous.stops.length > 0);
});

test('scheduled playback never reports an offset before the selected offset', () => {
  const audio = setup();
  audio.play(4, audio.ctx.currentTime + 0.2);
  assert.equal(audio.position(), 4);
});

test('a fresh source resets a previous playback-rate override', () => {
  const audio = setup();
  audio.setRate(1.02);
  audio.play(4);
  assert.equal(audio.source.playbackRate.value, 1);
  audio.ctx.currentTime += 5;
  assert.equal(audio.position(), 9);
});

test('scheduled handoff retains old audio until the new start time', () => {
  const audio = setup();
  const old = audio.source;
  const when = audio.ctx.currentTime + 0.15;
  audio.play(2, when);
  assert.equal(old.stops.at(-1), when);
});

test('repeated handoffs shorten every superseded source stop time', () => {
  const audio = setup();
  const first = audio.source;
  audio.play(2, 10.35);
  audio.play(3, 10.07);
  assert.equal(first.stops.at(-1), 10.07);
});

test('later handoff cannot extend an older source beyond its earliest stop', () => {
  const audio = setup();
  const first = audio.source;
  audio.play(2, 10.35);
  audio.ctx.currentTime = 10.1;
  audio.play(3, 10.45);
  assert.equal(first.stops.at(-1), 10.35);
});

test('correction cannot integrate before a scheduled source has started', () => {
  const audio = setup();
  audio.play(4, 10.5);
  audio.scheduleCorrection(.02, 2);
  audio.ctx.currentTime = 12;
  assert.equal(audio.position(), 5.5);
});

test('piecewise correction integrates rate and returns to the steady timeline', () => {
  const audio = setup();
  audio.scheduleCorrection(0.02, 2);
  audio.ctx.currentTime = 11;
  assert.ok(Math.abs(audio.position() - 1.02) < 1e-8);
  audio.ctx.currentTime = 13;
  assert.ok(Math.abs(audio.position() - 3.04) < 1e-8);
  assert.equal(audio.hasCorrection(), false);
});

test('pause is idempotent and preserves the current offset', () => {
  const audio = setup();
  audio.ctx.currentTime += 7;
  audio.pause(); audio.pause();
  assert.equal(audio.playing, false);
  assert.equal(audio.position(), 7);
});

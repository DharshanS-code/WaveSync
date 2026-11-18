import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/audio-engine.js';

class Param {
  value = 1;
  events = [];
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
  cancelAndHoldAtTime(time) { this.events.push(['hold', time]); }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
}
class Node {
  constructor(kind) { this.kind = kind; this.connections = []; }
  connect(target, output = 0, input = 0) { this.connections.push({ target, output, input }); return target; }
  disconnect() { this.disconnected = true; this.connections = []; }
}
class Source extends Node {
  constructor() { super('source'); }
  playbackRate = new Param();
  stops = [];
  start(when, offset) { this.started = { when, offset }; }
  stop(when) { this.stops.push(when); }
}
class Context {
  static instances = [];
  currentTime = 10;
  state = 'running';
  baseLatency = 0.01;
  outputLatency = 0.02;
  destination = new Node('destination');
  sources = [];
  gains = [];
  splitters = [];
  mergers = [];
  constructor() { Context.instances.push(this); }
  createGain() { const node = new Node('gain'); node.gain = new Param(); this.gains.push(node); return node; }
  createChannelSplitter(channels) { const node = new Node('splitter'); node.channels = channels; this.splitters.push(node); return node; }
  createChannelMerger(channels) { const node = new Node('merger'); node.channels = channels; this.mergers.push(node); return node; }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
globalThis.window = { AudioContext: Context };
const buffer = (duration = 60, channels = 1) => ({ duration, length: duration * 100, numberOfChannels: channels,
  getChannelData: channel => new Float32Array(duration * 100).fill(channel ? 0.2 : 0.1) });
function setup(buf = buffer()) { const audio = new AudioEngine(); audio.setBuffer(buf); audio.play(0); return audio; }

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

test('channel mode and volume settings are lazy before explicit audio activation', () => {
  const before = Context.instances.length;
  const audio = new AudioEngine();
  assert.equal(audio.channelMode, 'off');
  assert.equal(audio.channelCapability, true);
  assert.equal(audio.supportsChannelSelection, true);
  audio.setChannelMode('left');
  audio.setVolume(0.37);
  assert.equal(audio.channelMode, 'left');
  assert.equal(audio.volume, 0.37);
  assert.equal(audio.ctx, null);
  assert.equal(Context.instances.length, before);
  assert.throws(() => audio.setChannelMode('centre'), /left.*right.*off/i);
});

test('off preserves the original stereo source-to-gain path', () => {
  const audio = setup(buffer(60, 2));
  assert.equal(audio.source.connections[0].target, audio.gain);
  assert.equal(audio.ctx.splitters.length, 1);
  assert.equal(audio.ctx.mergers.length, 1);
});

test('left and right route one source channel to both local output channels', () => {
  const audio = setup(buffer(60, 2));
  const source = audio.source;
  const splitter = audio.ctx.splitters[0];
  const merger = audio.ctx.mergers[0];

  audio.setChannelMode('left');
  assert.equal(audio.source, source);
  assert.equal(source.connections[0].target, audio.gain);
  assert.deepEqual(splitter.connections.map(({ target, output }) => [target, output]),
    [[audio._channelLeftGain, 0], [audio._channelRightCancelGain, 1],
      [audio._channelLeftCancelGain, 0], [audio._channelRightGain, 1]]);
  assert.deepEqual(audio._channelGains.map(node => node.gain.value), [1, -1, 0, 0]);
  assert.deepEqual(audio._channelLeftGain.connections.map(({ target, input }) => [target, input]),
    [[merger, 1]]);

  audio.setChannelMode('right');
  assert.equal(audio.source, source);
  assert.deepEqual(audio._channelGains.map(node => node.gain.value), [0, 0, -1, 1]);
  assert.deepEqual(audio._channelRightGain.connections.map(({ target, input }) => [target, input]),
    [[merger, 0]]);
});

test('channel transitions retain source, playback position, and schedule short gain ramps', () => {
  const audio = setup(buffer(60, 2));
  audio.ctx.currentTime = 14;
  const source = audio.source;
  const position = audio.position();
  audio.setChannelMode('left');
  audio.setChannelMode('right');
  assert.equal(audio.source, source);
  assert.equal(audio.position(), position);
  const events = [...audio._channelLeftGain.gain.events, ...audio._channelRightGain.gain.events];
  assert.ok(events.some(event => event[0] === 'ramp'));
  assert.ok(events.filter(event => event[0] === 'hold' || event[0] === 'cancel').length >= 2);
  assert.ok(events.filter(event => event[0] === 'ramp').every(event => event[2] <= 14.05));
});

test('mono buffers retain normal mono output in every channel mode', () => {
  const audio = setup(buffer(60, 1));
  audio.setChannelMode('left');
  assert.equal(audio._effectiveChannelMode, 'off');
  audio.setChannelMode('right');
  assert.equal(audio._effectiveChannelMode, 'off');
  assert.equal(audio.source.connections[0].target, audio.gain);
});

test('missing splitter or merger degrades to original audio and reports no capability', () => {
  class LimitedContext extends Context {
    constructor() { super(); this.createChannelSplitter = undefined; }
  }
  const original = globalThis.window.AudioContext;
  globalThis.window.AudioContext = LimitedContext;
  try {
    const audio = new AudioEngine();
    audio.setChannelMode('left');
    audio.setBuffer(buffer(60, 2));
    audio.play(0);
    assert.equal(audio.channelCapability, false);
    assert.equal(audio.channelMode, 'left');
    assert.equal(audio._effectiveChannelMode, 'off');
    assert.equal(audio.source.connections[0].target, audio.gain);
  } finally {
    globalThis.window.AudioContext = original;
  }
});

test('channel mode survives disposal and rebuilds routing on context recreation', async () => {
  const audio = setup(buffer(60, 2));
  audio.setChannelMode('right');
  const oldContext = audio.ctx;
  await audio.dispose();
  assert.equal(audio.channelMode, 'right');
  audio.setBuffer(buffer(30, 2));
  audio.play(0);
  assert.notEqual(audio.ctx, oldContext);
  assert.equal(audio._effectiveChannelMode, 'right');
  assert.equal(audio.ctx.splitters.length, 1);
});

test('externally closed context rebuilds channel routing without stale nodes', async () => {
  const audio = setup(buffer(60, 2));
  audio.setChannelMode('left');
  const oldContext = audio.ctx;
  await oldContext.close();
  audio._ensure();
  assert.notEqual(audio.ctx, oldContext);
  assert.equal(audio._effectiveChannelMode, 'left');
  assert.equal(audio.ctx.splitters.length, 1);
});

test('setOutputDevice uses AudioContext setSinkId without eager activation', async () => {
  class SinkContext extends Context {
    sinkCalls = [];
    async setSinkId(id) { this.sinkCalls.push(id); }
  }
  const original = globalThis.window.AudioContext;
  globalThis.window.AudioContext = SinkContext;
  try {
    const audio = new AudioEngine();
    assert.equal(audio.outputDeviceCapability, true);
    const pending = audio.setOutputDevice('speaker-2');
    assert.equal(audio.ctx, null);
    assert.equal(await pending, false);
    await audio.resume();
    assert.equal(await audio.setOutputDevice('speaker-2'), true);
    assert.deepEqual(audio.ctx.sinkCalls, ['speaker-2']);
  } finally {
    globalThis.window.AudioContext = original;
  }
});

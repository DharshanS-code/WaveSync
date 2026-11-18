import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  setPreferences,
  resetPreferences,
  clearWaveSyncData,
  getStorageSummary
} from '../src/preferences.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
    snapshot() { return Object.fromEntries(data); }
  };
}

function withStorage(storage, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return run(); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
}

test('preferences expose immutable defaults and validate corrupt stored values', () => {
  const storage = memoryStorage({
    'wavesync.settings': JSON.stringify({
      rememberVolume: 'true',
      channelEnabled: 1,
      channelMode: 'center',
      autoSync: false,
      notifications: { room: false, playback: 'false', transfer: true, reconnect: null },
      soundEffects: true,
      browserNotifications: false,
      reducedMotion: true
    }),
    'wavesync.volume': 'Infinity'
  });

  withStorage(storage, () => {
    const preferences = readPreferences();
    assert.deepEqual(preferences, {
      ...DEFAULT_PREFERENCES,
      autoSync: false,
      notifications: { room: false, playback: true, transfer: true, reconnect: true },
      soundEffects: true,
      reducedMotion: true
    });
    assert.notStrictEqual(preferences.notifications, DEFAULT_PREFERENCES.notifications);
  });
});

test('setPreferences persists validated default volume in settings without writing last volume', () => {
  const storage = memoryStorage({ 'wavesync.volume': '0.37' });
  withStorage(storage, () => {
    assert.equal(setPreferences({
      defaultVolume: 4,
      rememberVolume: true,
      channelEnabled: true,
      channelMode: 'left',
      notifications: { playback: false },
      autoSync: 'false'
    }), true);

    const snapshot = storage.snapshot();
    assert.equal(snapshot['wavesync.volume'], '0.37');
    const saved = JSON.parse(snapshot['wavesync.settings']);
    assert.equal(saved.defaultVolume, 1);
    assert.equal(saved.autoSync, true);
    assert.equal(saved.channelEnabled, true);
    assert.equal(saved.channelMode, 'left');
    assert.deepEqual(saved.notifications, { room: true, playback: false, transfer: true, reconnect: true });
    assert.deepEqual(readPreferences(), {
      ...DEFAULT_PREFERENCES,
      channelEnabled: true,
      channelMode: 'left',
      notifications: { room: true, playback: false, transfer: true, reconnect: true }
    });
  });
});

test('configured default volume persists with rememberVolume disabled', () => {
  const storage = memoryStorage({ 'wavesync.volume': '0.4' });
  withStorage(storage, () => {
    assert.equal(setPreferences({ rememberVolume: false, defaultVolume: 0.2 }), true);
    assert.equal(storage.getItem('wavesync.volume'), null);
    assert.equal(JSON.parse(storage.getItem('wavesync.settings')).defaultVolume, 0.2);
    assert.equal(readPreferences().defaultVolume, 0.2);
    assert.equal(readPreferences().rememberVolume, false);
  });
});

test('unrelated preference changes do not overwrite remembered actual volume', () => {
  const storage = memoryStorage({
    'wavesync.settings': JSON.stringify({ ...DEFAULT_PREFERENCES, defaultVolume: 0.6 }),
    'wavesync.volume': '0.41'
  });
  withStorage(storage, () => {
    assert.equal(setPreferences({ autoSync: false }), true);
    assert.equal(storage.getItem('wavesync.volume'), '0.41');
    assert.equal(readPreferences().defaultVolume, 0.6);
  });
});

test('reset removes preferences and appearance/playback mode but preserves name and history', () => {
  const storage = memoryStorage({
    'wavesync.theme': 'dark',
    'wavesync.accent': 'violet',
    'wavesync.repeat': 'all',
    'wavesync.shuffle': 'true',
    'wavesync.settings': '{}',
    'wavesync.volume': '0.5',
    'wavesync.name': 'Listener',
    'wavesync.history': '["track"]',
    'thirdparty.key': 'keep'
  });
  withStorage(storage, () => {
    assert.deepEqual(resetPreferences(), {
      removedKeys: ['wavesync.theme', 'wavesync.accent', 'wavesync.repeat', 'wavesync.shuffle', 'wavesync.settings', 'wavesync.volume'],
      failedKeys: []
    });
    assert.deepEqual(storage.snapshot(), {
      'wavesync.name': 'Listener',
      'wavesync.history': '["track"]',
      'thirdparty.key': 'keep'
    });
  });
});

test('clear removes only local WaveSync keys and storage summary reveals no values', () => {
  const storage = memoryStorage({
    'wavesync.settings': '{"secret":"not returned"}',
    'wavesync.name': 'Private Name',
    'thirdparty.token': 'must-stay'
  });
  withStorage(storage, () => {
    const summary = getStorageSummary();
    assert.deepEqual(summary.keys, ['wavesync.name', 'wavesync.settings']);
    assert.equal(summary.count, 2);
    assert.equal(summary.approxBytes, ('wavesync.settings'.length + '{"secret":"not returned"}'.length + 'wavesync.name'.length + 'Private Name'.length) * 2);
    assert.equal(JSON.stringify(summary).includes('Private Name'), false);
    assert.equal(JSON.stringify(summary).includes('not returned'), false);

    assert.deepEqual(clearWaveSyncData(), {
      available: true,
      removedKeys: ['wavesync.name', 'wavesync.settings'],
      failedKeys: []
    });
    assert.deepEqual(storage.snapshot(), { 'thirdparty.token': 'must-stay' });
  });
});

test('blocked storage and corrupt JSON fall back safely without throwing', () => {
  const blocked = {
    get length() { throw new Error('blocked'); },
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  withStorage(blocked, () => {
    assert.deepEqual(readPreferences(), DEFAULT_PREFERENCES);
    assert.equal(setPreferences({ autoSync: false }), false);
    assert.deepEqual(resetPreferences().failedKeys.length, 6);
    assert.deepEqual(clearWaveSyncData(), { available: false, removedKeys: [], failedKeys: [] });
    assert.deepEqual(getStorageSummary(), { available: false, keys: [], count: 0, approxBytes: 0 });
  });

  withStorage(memoryStorage({ 'wavesync.settings': '{bad json' }), () => {
    assert.deepEqual(readPreferences(), DEFAULT_PREFERENCES);
  });
});

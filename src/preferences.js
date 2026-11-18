// preferences.js — validated, privacy-safe local preferences and storage controls.
import { readPreference, savePreference } from './config.js';

const CHANNEL_MODES = new Set(['off', 'left', 'right']);
const RESET_KEYS = ['theme', 'accent', 'repeat', 'shuffle', 'settings', 'volume'];
const NOTIFICATION_DEFAULTS = Object.freeze({
  room: true,
  playback: true,
  transfer: true,
  reconnect: true
});

/** Canonical preference values used when storage is absent, blocked, or invalid. */
export const DEFAULT_PREFERENCES = Object.freeze({
  defaultVolume: 1,
  rememberVolume: true,
  channelEnabled: false,
  channelMode: 'off',
  autoSync: true,
  notifications: NOTIFICATION_DEFAULTS,
  soundEffects: false,
  browserNotifications: false,
  reducedMotion: false
});

function validBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function validVolume(value, fallback) {
  const number = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function parseSettings(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function validateSettings(candidate, defaults = DEFAULT_PREFERENCES) {
  const source = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : {};
  const notificationSource = source.notifications && typeof source.notifications === 'object' &&
    !Array.isArray(source.notifications) ? source.notifications : {};

  return {
    defaultVolume: validVolume(source.defaultVolume, defaults.defaultVolume),
    rememberVolume: validBoolean(source.rememberVolume, defaults.rememberVolume),
    channelEnabled: validBoolean(source.channelEnabled, defaults.channelEnabled),
    channelMode: CHANNEL_MODES.has(source.channelMode) ? source.channelMode : defaults.channelMode,
    autoSync: validBoolean(source.autoSync, defaults.autoSync),
    notifications: {
      room: validBoolean(notificationSource.room, defaults.notifications.room),
      playback: validBoolean(notificationSource.playback, defaults.notifications.playback),
      transfer: validBoolean(notificationSource.transfer, defaults.notifications.transfer),
      reconnect: validBoolean(notificationSource.reconnect, defaults.notifications.reconnect)
    },
    soundEffects: validBoolean(source.soundEffects, defaults.soundEffects),
    browserNotifications: validBoolean(source.browserNotifications, defaults.browserNotifications),
    reducedMotion: validBoolean(source.reducedMotion, defaults.reducedMotion)
  };
}

function removePreference(key) {
  try {
    globalThis.localStorage?.removeItem(`wavesync.${key}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate configured settings. The actual remembered playback volume
 * in wavesync.volume is intentionally separate and is not returned here.
 */
export function readPreferences() {
  return validateSettings(parseSettings(readPreference('settings')));
}

/**
 * Merge a partial preference update with current values, validate it, and persist it.
 * Returns false instead of throwing when storage is unavailable.
 */
export function setPreferences(update) {
  const current = readPreferences();
  const source = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  const merged = {
    ...current,
    ...source,
    notifications: {
      ...current.notifications,
      ...(source.notifications && typeof source.notifications === 'object' &&
          !Array.isArray(source.notifications) ? source.notifications : {})
    }
  };
  const preferences = validateSettings(merged, current);

  if (!savePreference('settings', JSON.stringify(preferences))) return false;
  if (Object.hasOwn(source, 'rememberVolume') && preferences.rememberVolume === false) {
    return removePreference('volume');
  }
  return true;
}

/**
 * Remove settings plus appearance/repeat/shuffle preferences. Name and history
 * are deliberately preserved. Caller code is responsible for confirmation.
 */
export function resetPreferences() {
  const result = { removedKeys: [], failedKeys: [] };
  for (const key of RESET_KEYS) {
    const fullKey = `wavesync.${key}`;
    if (removePreference(key)) result.removedKeys.push(fullKey);
    else result.failedKeys.push(fullKey);
  }
  return result;
}

function waveSyncKeys() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return { available: false, keys: [] };
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === 'string' && key.startsWith('wavesync.')) keys.push(key);
    }
    keys.sort();
    return { available: true, keys };
  } catch {
    return { available: false, keys: [] };
  }
}

/**
 * Return key names, count, and an approximate UTF-16 byte total. Stored values
 * are used only for sizing and are never returned.
 */
export function getStorageSummary() {
  const found = waveSyncKeys();
  if (!found.available) return { available: false, keys: [], count: 0, approxBytes: 0 };

  let approxBytes = 0;
  try {
    for (const key of found.keys) {
      const value = globalThis.localStorage.getItem(key) ?? '';
      approxBytes += (key.length + value.length) * 2;
    }
  } catch {
    return { available: false, keys: found.keys, count: found.keys.length, approxBytes: 0 };
  }
  return { available: true, keys: found.keys, count: found.keys.length, approxBytes };
}

/**
 * Remove every localStorage key in the wavesync.* namespace and no others.
 * In-memory state such as resume-token maps is not inspected or modified.
 * Caller code is responsible for confirmation.
 */
export function clearWaveSyncData() {
  const found = waveSyncKeys();
  const result = { available: found.available, removedKeys: [], failedKeys: [] };
  if (!found.available) return result;

  for (const key of found.keys) {
    try {
      globalThis.localStorage.removeItem(key);
      result.removedKeys.push(key);
    } catch {
      result.failedKeys.push(key);
    }
  }
  return result;
}

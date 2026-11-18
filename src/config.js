// config.js — runtime configuration for this deployment.
import { DEPLOYMENT } from './deployment.js';
// Builds provide their own public endpoint. Overrides remain loopback-only.
export const DEFAULT_SIGNAL_URL = DEPLOYMENT.signalUrl;
export function readPreference(key, fallback = null) {
  try { return globalThis.localStorage?.getItem(`wavesync.${key}`) ?? fallback; }
  catch { return fallback; }
}
export function savePreference(key, value) {
  try { globalThis.localStorage?.setItem(`wavesync.${key}`, String(value)); return true; }
  catch { return false; }
}
export function validateSignalUrl(value, page = globalThis.location) {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (page?.protocol === 'https:' && url.protocol !== 'wss:')) {
    throw new Error('Use a WebSocket URL (wss:// on HTTPS), without credentials or fragments.');
  }
  return url.href;
}
export function resolveSignalUrl(page = globalThis.location, deployment = DEPLOYMENT) {
  if (!page) return 'ws://localhost:8787/api/room';
  const isDev = ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
  if (!isDev) {
    if (!deployment?.signalUrl) return '';
    try { return validateSignalUrl(deployment.signalUrl, page); }
    catch { return ''; }
  }
  const override = new URLSearchParams(page.search).get('signal');
  if (override) {
    try { return validateSignalUrl(override, page); } catch { /* Fall back to the local server. */ }
  }
  return page.protocol === 'https:' ? 'wss://localhost:8787/api/room' : 'ws://localhost:8787/api/room';
}

export const CONFIG = {
  signalUrl: resolveSignalUrl(),
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],

  // Clock synchronization
  clockSampleIntervalMs: 2000,
  clockBurstCount: 8,
  clockBurstIntervalMs: 220,
  clockWindow: 30,
  clockEmaAlpha: 0.15,

  // Timeline / drift correction
  timelineHeartbeatMs: 2000,
  syncCheckMs: 250,
  softThresholdSec: 0.02,
  hardThresholdSec: 0.25,
  maxRateAdjust: 0.02,
  driftKp: 0.9,
  driftKi: 0.05,
  scheduleLeadSec: 0.02,
  holdToleranceSec: 0.006,   // dead-band around 0: don't correct within ±6ms
  convergeSec: 1.2,          // gentle: drive error to exactly 0 over ~1.2s (no pitch distortion)
  minCorrectionSec: 0.1,     // shortest correction window

  // setTimeline: how far a heartbeat's extrapolated position may drift from
  // its actual reported position before it's treated as a real discontinuity
  // (seek/track change) instead of routine heartbeat noise. Tune against
  // measured clock-offset jitter, not just RTT.
  discontinuityToleranceSec: 0.08,

  // Predictive scheduling lead (H2): base + this many multiples of measured
  // local scheduler jitter, floored while the tab is hidden (timer throttling
  // there is large and abrupt) and capped so a bad reading can't push a
  // reseek arbitrarily far into the future.
  leadJitterMultiplier: 3,
  backgroundLeadFloorSec: 0.35,
  maxLeadSec: 0.5,

  // P2P latency ping cadence over the WebRTC fast lane (telemetry only).
  p2pPingIntervalMs: 2000,

  // Calibration
  calibMinSamples: 5,
  calibMinConfidence: 0.6,
  calibMaxWaitMs: 6000,

  // Transfer
  chunkSize: 16 * 1024,
  bufferAheadSec: 120
};

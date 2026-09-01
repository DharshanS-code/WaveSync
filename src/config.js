// config.js — runtime configuration for WaveSync.
// Signaling URL resolution order:
//   1. ?signal=wss://... query param
//   2. localStorage 'wavesync.signal'
//   3. auto: localhost -> Node dev server :8787, otherwise same-origin /api/room
function resolveSignalUrl() {
  const q = new URLSearchParams(location.search).get('signal');
  if (q) return q;
  const saved = localStorage.getItem('wavesync.signal');
  if (saved) return saved;

  const host = location.hostname;
  const isDev = host === 'localhost' || host === '127.0.0.1' || host === '' || location.protocol === 'file:';
  if (isDev) return 'ws://localhost:8787/api/room';
  // Public shared backend — every user connects here automatically, no setup.
  return 'wss://wavesync-signal.dharshandcu.workers.dev/api/room';
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
  syncCheckMs: 1000,
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

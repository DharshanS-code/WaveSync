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
  // Sync tuning
  clockSampleIntervalMs: 2000,
  timelineHeartbeatMs: 2000,
  syncCheckMs: 100,          // 0.1s adaptive checks
  softThresholdSec: 0.02,    // start smooth rate correction above 20ms
  hardThresholdSec: 0.25,    // hard reseek above 250ms
  maxRateAdjust: 0.04,       // +/-4% playbackRate nudge
  // Transfer
  chunkSize: 16 * 1024,
  bufferAheadSec: 120        // target ahead-buffer (progressive transfer)
};

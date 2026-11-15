export const LIMITS = Object.freeze({
  maxEncodedBytes: 32 * 1024 * 1024,
  maxGuests: 8,
  maxTracks: 100,
  signalBytes: 65_536
});

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const SDP_TYPES = new Set(['offer', 'answer', 'pranswer', 'rollback']);
const TRACK_KEYS = ['kind', 'epoch', 'trackId', 'name', 'mime', 'size', 'duration'];
const TIMELINE_KEYS = ['kind', 'epoch', 'trackId', 'seq', 'revision', 'playing', 'position', 'atServerTime', 'duration'];
const CANDIDATE_KEYS = new Set(['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);

export function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function finite(value, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function boundedString(value, maximum, allowEmpty = false) {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0);
}

function encodedBytes(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return Infinity;
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
    return unescape(encodeURIComponent(text)).length;
  } catch {
    return Infinity;
  }
}

export function validCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

export function validTimeline(data, now = Date.now()) {
  return isObject(data)
    && exactKeys(data, TIMELINE_KEYS)
    && data.kind === 'timeline'
    && boundedString(data.epoch, 128)
    && boundedString(data.trackId, 128)
    && Number.isSafeInteger(data.seq) && data.seq >= 0
    && Number.isSafeInteger(data.revision) && data.revision >= 0
    && typeof data.playing === 'boolean'
    && finite(data.position)
    && finite(data.atServerTime)
    && data.atServerTime <= 8_640_000_000_000_000
    && (now === null || data.atServerTime <= now + 10_000)
    && finite(data.duration)
    && data.position <= data.duration;
}

export function validTrack(data) {
  return isObject(data)
    && exactKeys(data, TRACK_KEYS)
    && data.kind === 'track'
    && boundedString(data.epoch, 128)
    && boundedString(data.trackId, 128)
    && boundedString(data.name, 200)
    && boundedString(data.mime, 128)
    && Number.isSafeInteger(data.size) && data.size >= 0 && data.size <= LIMITS.maxEncodedBytes
    && finite(data.duration);
}

export function validSignal(data) {
  if (!isObject(data) || encodedBytes(data) > LIMITS.signalBytes) return false;
  const keys = Object.keys(data);
  if (keys.length !== 1) return false;
  if (Object.hasOwn(data, 'sdp')) {
    const value = data.sdp;
    let sdp = value;
    if (!isObject(sdp) && value && typeof value.toJSON === 'function') {
      try { sdp = value.toJSON(); } catch { return false; }
    }
    return isObject(sdp)
      && exactKeys(sdp, ['type', 'sdp'])
      && SDP_TYPES.has(sdp.type)
      && boundedString(sdp.sdp, LIMITS.signalBytes, true);
  }
  if (!Object.hasOwn(data, 'candidate')) return false;
  const candidate = data.candidate;
  if (!isObject(candidate)) return false;
  const candidateKeys = Object.keys(candidate);
  if (candidateKeys.length < 1 || candidateKeys.some((key) => !CANDIDATE_KEYS.has(key))) return false;
  if (!boundedString(candidate.candidate, LIMITS.signalBytes, true)) return false;
  if (Object.hasOwn(candidate, 'sdpMid') && candidate.sdpMid !== null && !boundedString(candidate.sdpMid, 256, true)) return false;
  if (Object.hasOwn(candidate, 'sdpMLineIndex') && candidate.sdpMLineIndex !== null
    && (!Number.isSafeInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0)) return false;
  if (Object.hasOwn(candidate, 'usernameFragment') && candidate.usernameFragment !== null
    && !boundedString(candidate.usernameFragment, 256, true)) return false;
  return true;
}

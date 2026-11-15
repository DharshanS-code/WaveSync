# WaveSync architecture

WaveSync remains a small native ES-module PWA. Signaling coordinates a host-authoritative room; audio files travel directly over encrypted WebRTC DataChannels in a host-to-guest star. The signaling service never receives audio bytes.

## Ownership

- `src/app.js`: room lifecycle, role/readiness state, operation generations, module integration. Session, selection, and transport tokens prevent late operations from changing a newer room or overriding Pause.
- `src/track-store.js`: stable track IDs, queue operations, bounded current/next decoded cache. Queue indices are presentation, never network identity.
- `src/audio-engine.js`: decode, source-node ownership, scheduled handoffs, gain, AudioContext lifecycle. Activating a buffer stops the old source and resets position/rate/correction. Superseded sources retain their earliest stop time.
- `src/sync-engine.js`: clock mapping, host timeline acceptance, scheduled alignment and adaptive drift correction. Duplicate/lower sequences and mismatched epochs/tracks are rejected.
- `src/network-quality.js`: browser capabilities, coarse estimated hints, actual transfer throughput/stalls and matched peer telemetry. Hardware RSSI/channel/band remains unavailable in the web app.
- `src/network.js`: reconnecting signaling, in-memory resume credentials, serialized SDP/early ICE, host-star peer authorization, identity-guarded callbacks and repair.
- `src/transfer.js`: one active reliable transfer per peer, bounded queue/assembly, unique transfer IDs, exact EOF size, close/error/timeout-safe backpressure.
- `src/ui.js`: safe text rendering and delegated actions; no audio/network mutation. `src/styles.css` owns responsive tokens, themes and accessibility.
- `shared/protocol.js`: shared strict validation and limits.
- `backend/room-state.js`: runtime-independent membership/topology/control reducer shared by Node and Cloudflare adapters.

## Audio pipeline

Local File → encoded bytes → browser `decodeAudioData` → Float32 AudioBuffer → BufferSource → gain → destination. Guests transfer and decode the complete file before playback. This is full-file distribution, not progressive playable streaming. Large decoded buffers remain expensive: five minutes of stereo 44.1kHz Float32 audio uses about 106MB before encoded copies and browser overhead.

Bounds: 32MiB encoded/file, 128MiB decoded/track, 192MiB decoded cache, at most two cache entries, 100 queue entries, 8 guests. Decode size checking is post-decode because Web Audio exposes decoded dimensions only afterward; it cannot prevent the browser's transient decode allocation. Optional next-track prefetch is disabled under data-saving hints. Source and cache cleanup release references on leave.

## Synchronization

Clock probes use local `performance.now()` and server timestamps. Four timestamps subtract server processing when available; midpoint mapping assumes symmetric paths. Independent low-delay observations estimate the offset, uncertainty, and jitter. At least five samples are required for calibration. Client wall-clock adjustments do not affect extrapolation.

The host publishes `{epoch,trackId,seq,revision,playing,position,atServerTime,duration}`. Sequence increases every update; revision changes for transport discontinuities. Guest audio can align only with the current track, running AudioContext, calibrated clock, and available host. Host loss disarms the retained timeline; an authoritative recovery snapshot is required.

Output timestamp mapping is preferred where supported. Otherwise base/output latency is an implementation estimate, not measured acoustic/Bluetooth latency. Smooth bounded playback-rate changes correct small errors and can alter pitch. Consecutive or gross errors trigger a scheduled hard handoff; old audio is not stopped before its replacement starts.

Network adaptation changes safety margins, transfer buffering/timeouts and optional preload based on delivery variation/stalls plus coarse browser hints. Clock estimation, scheduling risk and audio output timing remain separate. No RSSI-to-latency formula or RTT-only Wi-Fi quality claim.

## Room recovery/security

Registered sockets have stable participant IDs and private in-memory resume tokens. Tokens are never in invitations. Rejoin is a generation boundary: old peers/channels close before fresh negotiation. Host loss pauses server state with a 30-second grace; guest identity retention is 120 seconds. Explicit host leave ends the room. Only the registered current host may publish controls, and signaling is allowed only host↔guest. Inputs are schema/size/rate bounded; cleanup is idempotent.

Cloudflare Durable Object naming serializes each room, but this implementation keeps live room state in memory. Runtime/object restart loses rooms and requires a new room; no durable playback recovery claim. Node restart likewise loses rooms.

## PWA/build

`npm run build` creates an allowlisted `dist/` static artifact and content-derived service-worker revision. Installation requires the complete shell; cache refresh is coherent, not independent module replacement. A waiting worker activates only after the user leaves a room and requests an update. Cleanup is app/scope-specific; API/audio traffic is not cached. Offline shell does not mean offline room signaling.

## Limits requiring real environments

One-host fanout consumes upload bandwidth per guest. STUN is not TURN: cross-NAT connections can fail. Safari/iOS gestures, interruptions and background policies differ. No acoustic divergence, true Wi-Fi hardware/band/congestion, Bluetooth/output-device compensation, independent-clock multi-device accuracy or Cloudflare deployment has been validated merely by local tests.

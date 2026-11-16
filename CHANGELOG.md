# Changelog

## Re-engineering branch (unreleased)

- Replaced unsafe queue-index media identity with stable tracks and unique transfers.
- Added host-star signaling authority, strict shared payload validation, participant/message/resource limits, resumable live-room identities and generation-safe cleanup.
- Serialized reliable file transfer, bounded receiver assembly and pending frames, cancellable/timeout backpressure, queued ICE and peer rebuild on welcome.
- Made audio activation atomic; reset rate/position; scheduled handoffs preserve old audio until transition without extending old stop times; lifecycle interruptions disarm playback.
- Added monotonic clock mapping, independent calibration samples, timeline sequence/epoch/revision checks and sustained-error drift policy.
- Added capability-detected network adaptation using observed delivery and coarse estimated browser hints. No fabricated Wi-Fi hardware or acoustic-accuracy claim.
- Added bounded current/next cache, playlist append/reorder/remove, repeat/shuffle, local preference/history storage and role-aware Media Session controls.
- Rebuilt original mobile/desktop music UI with light/dark/system themes, accents, safe text rendering, focus/live feedback, local audio enable and real diagnostics.
- Added coherent shell service-worker update policy, offline invitation fallback and content-derived static build; localhost source development does not register an unrevisioned worker.
- Added unit/backend/browser tests and development/architecture/testing/deployment documentation.

Remaining release gates include physical-device acoustic validation, Android/iOS lifecycle/accessibility behavior, real Wi-Fi/output-device matrix, Cloudflare deployment, and production protocol migration. This is not a claim of completed production qualification.

# Changelog

## 1.5.0 — 2026-11-18 (release candidate)

- Redesigned the mobile-first listening interface, original identity assets, desktop navigation and accessible mobile drawer.
- Added dedicated Settings and Privacy pages, local Channel System Beta (Off/Left/Right), independent volume preferences, automatic-sync controls and capability-aware notifications/output selection.
- Added independent room QR generation and official-only optional creator support.
- Separated explicit official and default self-hosted builds. Self-hosted artifacts omit the owner's signaling endpoint, support/payment implementation and personal promotional UI; unconfigured public deployments disable Create/Join with setup guidance.
- Added exact staged build ownership inventories, profile-specific service-worker shells and fork-safe Pages artifact selection.
- Polished button feedback, theme-aware static gradients, page/drawer/dialog transitions and nonblocking standalone opening with reduced-motion support.
- Fixed teardown races for pending confirmations and delayed official feature loading, with failing-then-passing regressions.
- Preserved the locally maintained dashboard Worker bundle and endpoint restrictions; no upstream source was pulled.

Release qualification: final tests were skipped at the owner's request. Earlier source checks passed 125 tests; the subsequent three teardown regressions passed independently and were re-reviewed. Both final profiles build successfully. Final full-suite/browser acceptance, physical-device audio/PWA behavior and deployed Worker compatibility remain unconfirmed. This candidate must not be treated as production-qualified solely from those earlier checks.

## Previous re-engineering work (already merged)

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

# WaveSync design contract

## Direction
A quiet listening workspace, not a generic dashboard or marketing page. Warm porcelain and graphite surfaces, a restrained vermilion accent, precise system typography, and an original paired-wave mark. The memorable detail is the paired phase lines repeated in the identity and player artwork. Existing native ES modules, room lifecycle, protocol validation, bounded transfers and timing engines remain authoritative. Deployment identity/signaling is profile-selected: self-hosted is neutral with no owner endpoint fallback; official retains the owner's inputs.

## Product contract
- Home explains local music shared across devices and exposes device name, Create and Join immediately. A visible return-to-room action preserves active playback when navigating Home.
- Desktop: 232px persistent grouped navigation and a bounded content column. Mobile: header and explicitly opened modal drawer, never squeezed desktop navigation.
- Room: code/share and role first, current track/transport next, playlist and devices alongside on wide screens, stacked on phones. Guest transport authority is unchanged.
- Settings is a real route: appearance, local audio, synchronization, notifications, privacy, About. Every setting must change real behavior or explicitly show an unsupported capability.
- Privacy reflects generated public operator/provider configuration. Support markup/styles/routes/controller and personal promotional identity are emitted only in official builds, fail-closed behind runtime `config/features.json`. Self-hosted has no support implementation/fetch; MIT attribution remains. Home alone has the global footer.
- URLs use hash views to remain compatible with static subdirectory hosting; room invitations retain the existing query semantics. View changes do not leave rooms.

## Tokens
Page, solid/elevated/quiet surface, primary/secondary text, border/control border, accent/accent ink, success/warning/danger/focus are semantic CSS variables with independent light/dark values. Coral is the default; existing rose/amber preferences remain compatible. No hardware Wi-Fi metrics or acoustic-accuracy promises.

System font stack; page/display title 32–48px (36px on common phones), section 18–28px, body 14–16px, labels 13–14px, compact captions 10–12px. Timers/diagnostics use tabular numerals. Spacing: 4, 8, 12, 16, 24, 32, 48, 64px. Radii: 8px controls, 14px panels, 16px confirmation sheets. Solid content surfaces; restrained glass only on navigation/modal overlays with a solid fallback. Stroke icons use a common 24px viewBox and 1.7–1.8px strokes.

## Interaction and accessibility
44px practical interactive targets; native labelled inputs/buttons/anchors; visible theme-aware keyboard focus; scoped transparent WebKit tap highlight on interactive elements, not global focus removal. Modal drawers and confirmations contain focus, support Escape/backdrop dismissal, restore focus and lock scrolling. Reduced motion eliminates decorative movement. Safe-area padding and no horizontal overflow from 320px. Dynamic status announcements are concise, not repeated every clock tick.

## Motion and depth
Shared durations: feedback 120ms, page 200ms, overlay 240ms, exit 160ms, with `cubic-bezier(.22,.8,.25,1)` easing and subtle `.985` press scaling. Static theme-aware gradients are reserved for player artwork and selected elevated surfaces; forms/reading remain solid. Forced colors use Canvas. Pointer hover is limited to fine pointers.

Page, drawer/backdrop and confirmation transitions animate only opacity/transform. Screen/navigation state changes immediately, without delaying audio controls or recreating player state. Canceled/superseded exits cannot run stale cleanup. Modal focus, inert and scroll-lock state remain authoritative. OS or stored reduced motion disables decorative movement and press scaling, including changes while an animation is active. A short once-per-document standalone reveal is progressive enhancement, not a loading overlay or OS splash replacement. No physical-device frame-rate guarantee is claimed.

## State evidence contract
| State | Trigger | Feedback / safe next action |
| --- | --- | --- |
| Loading | Create/join, transfer, decode | Existing connection/transfer progress and status; leave or retry safely |
| Empty | No room/playlist/track/devices | Create/join, add files (host), wait for host (guest) |
| Error | Invalid/expired room, transfer/decode/copy failure | Actionable existing error/toast, explicit re-entry or another file |
| Partial | Unsupported output APIs, uncalibrated clock, host recovery | Show available facts and unavailable capabilities, never guessed values |
| Success | Room ready, copied invite/UPI, track available | Status and next useful action; no payment verification claim |
| Permission | Suspended audio/notifications | Explicit request, explanation, unsupported/denied graceful fallback |

## Verification targets
320×844, 390×844, 768×1024, 1440×900; light/dark/system, portrait/landscape where possible. Inspect Home, drawer, room host/guest, Settings, Privacy, Support, errors and permissions. Measure actual screenshots/overflow/focus and report environment failures honestly. Baseline: 65 unit tests passed; lint/build passed. Unmodified browser command failed on Node `process.platform === 'android'`; the repository already offers `WAVESYNC_PROOT_BROWSER=1` compatibility mode. External design repositories will not be fetched because the owner requested local-only work.

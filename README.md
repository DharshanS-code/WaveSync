# WaveSync

**Listen together. Keep your music local.**

WaveSync is a mobile-first music PWA. A host selects local audio, guests receive it directly over encrypted WebRTC, and a host-authoritative timeline coordinates playback. No accounts or server-side audio upload. Actual acoustic synchronization depends on browser, device, network and output route; perfect or submillisecond accuracy is not guaranteed.

## Features

- Local browser-decoded audio with bounded current/next caching.
- Playlist append, track selection, previous/next, removal and keyboard/pointer reordering; repeat and shuffle.
- Host-only transport controls; guest local volume, explicit audio activation and manual resync.
- Stable track/transfer identity, serialized file transfer and backpressure/resource limits.
- Live-room identity resume, peer rebuilding, authoritative pause on host loss and deliberate re-entry after expired recovery.
- Original responsive music interface, light/dark/system themes and accents, accessible labels/focus/live errors, safe-area and reduced-motion support.
- Estimated clock/output diagnostics and adaptive delivery buffering; unavailable Wi-Fi hardware information is explicitly not fabricated.
- Versioned offline application shell and safe user-requested updates outside active rooms.

Audio format support follows actual browser `decodeAudioData`; unsupported or corrupt files produce an error. Full transfer/decode is required before guest playback: this is not progressive streaming.

## Run locally

```bash
npm install --ignore-scripts
npm run dev
```

Open **http://localhost:3000**. Create a room, add audio, wait for clock calibration, and press Play. In another browser/device, enter the room code or use the invitation link. Guests may need to tap **Enable audio**.

The local server binds loopback, so another phone cannot use your laptop's localhost. Physical LAN tests require trusted HTTPS/WSS or your deployed infrastructure. Never use plaintext ws from an HTTPS page.

```bash
npm test
npm run lint
npm run build
npm run test:browser
```

The `lint` command verifies syntax/imports/assets, not ESLint or static types. Build creates a verified static ES-module artifact in `dist/` with a content-derived service-worker revision. Deploy **only dist**, not repository root.

On Android shared storage: `npm install --ignore-scripts --bin-links=false`. Debian PRoot Chromium tests may require `WAVESYNC_PROOT_BROWSER=1 npm run test:browser`; see development notes for the explicitly approved local test-only sandbox exception.

## Signaling and deployment

Local default: `ws://localhost:8787/api/room`. Production fallback preserves the project's public Worker at `wss://wavesync-signal.dharshandcu.workers.dev/api/room`. To use your own service, set Connection & appearance → Signaling endpoint or use `?signal=wss://.../api/room`. Invitation links retain the chosen endpoint; they never include private resume tokens.

**The re-engineered frontend and backend must be deployed together.** The public Worker may still run the old protocol until its owner deploys the matching backend. Local verification does not establish production endpoint compatibility. No paid service or production deployment is required for local work.

See [DEPLOYMENT.md](DEPLOYMENT.md) before publishing. STUN helps direct connectivity but is not TURN; cross-NAT or client-isolated Wi-Fi can fail. Host-star upload grows with guest count; the room limit is eight guests.

## Timing and Wi-Fi limitations

Clock calibration maps monotonic local timestamps to server time using independent midpoint samples, with an explicitly symmetric-path assumption and uncertainty. Playback uses the Web Audio clock, output timestamp mapping where available, and bounded gradual/hard correction. Rate adjustment can alter pitch. Browser latency APIs are implementation estimates, not external acoustic calibration.

Ordinary browsers do not expose RSSI, Wi-Fi link speed, frequency band/channel, PHY or congestion. Optional Network Information API downlink/effectiveType/saveData are coarse estimates. Actual transfer throughput/stalls and matched peer delivery variation guide buffering/timeouts/preloading. RTT is not a direct Wi-Fi-quality or output-latency measurement. Native Android/desktop Wi-Fi instrumentation would require a separate native boundary and permission/API review; none is fabricated or required here.

## Reliability and privacy

Server validates host role/identity, host↔guest signaling, epochs, track identity, sequences and bounded payloads. File and decoded-memory budgets help low-memory devices, but decode checking occurs after the browser allocates PCM. Signaling carries metadata/names and coordination; audio remains direct P2P. Local preferences/history remain in the current browser and can be cleared using site-data controls.

Room resume is in-memory and time-limited. Node/Cloudflare object restart loses room state and requires a fresh room. Offline shell does not mean offline room functionality. Background playback, mobile interruptions, real Wi-Fi/output-device conditions and acoustic divergence need physical testing.

## Documentation

- [Architecture and audio/sync pipeline](ARCHITECTURE.md)
- [Development and PRoot environment](DEVELOPMENT.md)
- [Tests and physical-device acceptance matrix](TESTING.md)
- [Deployment and protocol migration](DEPLOYMENT.md)
- [Unreleased engineering changes](CHANGELOG.md)

## License

[MIT](LICENSE). Existing WaveSync branding and optional support information are retained.

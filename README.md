# WaveSync — Synchronized Music Player

**Play one song in perfect sync across every device on your network.**

WaveSync is an open-source, mobile-first **PWA**. A host picks tracks from their
device, WaveSync streams the audio **peer-to-peer over WebRTC** to every guest,
and a dedicated **synchronization engine** keeps all devices locked to a shared
GMT/UTC clock with sub-100 ms accuracy.

> Zero-cost by design: LAN-first WebRTC using only free Google STUN — **no paid
> TURN server required** when devices share the same Wi-Fi/network.

---

## ✨ Features

- 🎵 **Local audio, with a queue** — host selects one or more MP3 / AAC / WAV / OGG-Opus / FLAC files (browser-supported), builds a queue, and skips prev/next. The next queued track is transferred to guests ahead of time for a near-gapless handoff.
- 📡 **P2P audio transfer** — audio travels host→guests over WebRTC DataChannels; it never touches a server.
- ⏱️ **Sync engine** — host-authoritative timeline, NTP-style shared clock (Kalman-filtered offset), RTT/jitter tracking, periodic drift checks, smooth rate correction (±2% playback rate) with hysteresis-gated hard reseek for gross errors.
- 🚪 **Rooms** — create/join, short code, shareable link, host/guest roles, live device count, host playback control, leave, auto-reconnect with backoff.
- 🧊 **Calibration screen** — before playback starts, both host and guest see a live step-by-step readout (linking → clock sync → lock) with RTT/offset/confidence, so you know sync is actually solid before the music starts.
- 📱 **PWA** — `manifest.json`, service worker, installable, offline app shell, responsive, Media Session API (lock-screen play/pause + track title on the host).
- 🔊 **Loudness normalization** — each decoded track is RMS-analyzed and gain-adjusted so volume stays consistent across different source files.
- 🧊 **Claymorphism UI** — soft rounded surfaces, depth, lightweight animations, touch-friendly.
- 💚 **Support card** — an in-app "Support" panel (UPI QR + links) for anyone who wants to tip the project; entirely optional and dismissible.
- 🔒 **Secure** — random unambiguous room codes, host-only control authorization, input validation, HTTPS/WSS ready.

---

## 🗂 Project structure

```
WaveSync/
├── index.html            # app shell (home, host player, guest player, calibration, support card)
├── manifest.json         # PWA manifest
├── sw.js                 # service worker (offline shell)
├── package.json
├── assets/                # PWA icons + support QR
├── src/
│   ├── config.js          # signaling URL + sync tuning
│   ├── app.js              # orchestrator (host + guest, queue, calibration, UI wiring)
│   ├── audio-engine.js     # Web Audio decode + scheduled playback + loudness normalization
│   ├── sync-engine.js      # ClockSynchronizer + SyncEngine (Kalman filter, drift control)
│   ├── network.js          # signaling client + WebRTC peer mesh + file transfer
│   ├── ui.js                # DOM helpers
│   └── styles.css           # claymorphism theme
├── backend/
│   ├── worker.js            # Cloudflare Worker + Durable Object (RoomDO)
│   ├── dev-server.js        # Node dev signaling server (local testing)
│   ├── wrangler.toml        # Cloudflare deploy config
│   └── package.json
├── LICENSE                  # MIT
└── README.md
```

---

## 🚀 Run locally

**Requirements:** Node 18+ and a modern browser. WebRTC + Web Audio need a
*secure context*: `http://localhost` counts as secure, so localhost works.

```bash
# 1. install the dev signaling server dependency (ws)
npm install

# 2. start the signaling server  →  ws://localhost:8787/api/room
npm run signal

# 3. in another terminal, serve the static app on http://localhost:3000
npm run serve
```

Open **http://localhost:3000** on your phone/laptop.

- **Create Room** → pick one or more audio files → press play. Use prev/next to move through the queue.
- On another device (same network) open the shared link or enter the room code → **Join Room**.

> **Testing on multiple physical devices?** They must reach the signaling
> server. Either deploy the Worker (below) or run the dev server and open the
> app via your machine's LAN IP over HTTPS, then set the signaling URL with
> `?signal=ws://<LAN-IP>:8787/api/room`. (Browsers require a secure context for
> WebRTC/Web Audio on non-localhost origins — deploying is the simplest path.)

---

## ☁️ Deploy signaling to Cloudflare Workers

Durable Objects require the **Workers Paid plan** *or* are available on the free
plan in many accounts — check your dashboard. Deployment itself is free-tier
friendly.

```bash
cd backend
npx wrangler login
npx wrangler deploy        # deploys worker.js + RoomDO durable object
```

Your signaling endpoint becomes:

```
wss://wavesync-signal.<your-subdomain>.workers.dev/api/room
```

### Point the PWA at your Worker

The frontend auto-resolves the signaling URL (`src/config.js`):

1. `?signal=wss://…` query parameter (highest priority)
2. `localStorage['wavesync.signal']`
3. **Auto:** same-origin `/api/room` in production, `ws://localhost:8787/api/room` on localhost.

**Cloudflare Pages + Workers (recommended):** host the static files on
**Cloudflare Pages** and add a route so `/api/room` on your Pages domain maps to
the Worker (Workers Routes or a `_routes`/service binding). Then the app uses
`wss://<your-domain>/api/room` automatically — no config needed.

**Quick alternative:** host static files anywhere and append the signaling URL:

```
https://your-app.pages.dev/?signal=wss://wavesync-signal.<sub>.workers.dev/api/room
```

You can also uncomment the `[assets]` block in `wrangler.toml` to serve the PWA
from the same Worker origin.

---

## 🧠 How synchronization works

1. **Shared clock.** Every client runs an NTP-style exchange with the signaling
   server (`t0` sent, server replies with `t1`, client stamps `t2`). Offset =
   `t1 − (t0+t2)/2`; the lowest-RTT sample wins, fused over time by a Kalman
   filter. `clock.now()` = a shared GMT estimate on all devices.
2. **Host-authoritative timeline.** On every play/pause/seek/track-change (plus
   a 2 s heartbeat) the host broadcasts `{ playing, position, atServerTime, seq }`.
3. **Guest scheduling.** Guests decode the transferred audio locally and play it
   via `AudioBufferSourceNode` — sample-accurate and immune to timer jitter.
   `expectedPosition = position + (clock.now() − atServerTime)`.
4. **Drift control (checked every 1 s).** `error = heardPosition − expectedPosition`.
   - `|error| ≤ 6 ms` → hold, do nothing.
   - `6 ms – 250 ms` → smoothly nudge `playbackRate` (±2%, converging over ~1.2 s) to drive the error to exactly 0.
   - `> 250 ms`, confirmed over two consecutive checks (debounced against transient jitter) → hard reseek to the exact position.

Audio bytes move **peer-to-peer** over WebRTC DataChannels; the server only
relays tiny signaling/clock/control messages.

---

## ✅ MVP checklist

| Capability | Where |
|---|---|
| Local audio selection + queue | `app.js › onFiles / loadTrack / nextTrack / prevTrack` |
| Audio playback + loudness normalization | `audio-engine.js` |
| Room creation / joining | `app.js`, `worker.js`, `dev-server.js` |
| WebRTC connection | `network.js › Peer` |
| Live audio transmission (P2P) | `network.js › sendFile / DataChannel` |
| Playback synchronization | `sync-engine.js › SyncEngine` |
| Clock synchronization | `sync-engine.js › ClockSynchronizer` |
| Drift correction | `SyncEngine._monitor` |
| Buffering | progressive DataChannel transfer + `guest-buffer` UI |
| Reconnection | `network.js › SignalClient` backoff |
| Calibration UX | `app.js › _startCalibration / _calibProgress` |
| Media Session (lock-screen controls) | `app.js › _setMediaSession` |
| PWA installation | `manifest.json`, `sw.js` |
| Responsive UI | `styles.css` |
| Build integrity | pure ES modules, no build step |

---

## 🔒 Security notes

- Room codes use an unambiguous 6-char alphabet; guests can only join an
  existing room.
- **Control messages are host-only** — the server drops `control` frames from
  non-host sessions (host-authoritative).
- All inputs are validated (code regex, message shape, name length caps).
- Works over **HTTPS/WSS**; WebRTC is DTLS-encrypted by default.

---

## 🌐 Browser support

Chromium (Chrome/Edge/Brave), Firefox, and Safari 15+. FLAC/Opus decoding
depends on the browser's `decodeAudioData` support. iOS requires a user gesture
to start audio (handled: playback begins after a tap).

---

## 📄 License

[MIT](./LICENSE) © WaveSync contributors.

# WaveSync

**Zero-latency synced music over Wi-Fi. One song, every phone, same instant.**
#https://github.com/DharshanS-code/WaveSync#quick-start
WaveSync plays one track across every device on the same Wi-Fi network,
perfectly in time — no codes, no accounts, no cloud. Open the page, and
you're already in.

---

## How it works

| Feature | Detail |
|---|---|
| **Auto-discovery** | Every device on the same Wi-Fi announces itself and joins automatically. No room codes. |
| **Host election** | The first device online becomes host (lowest session ID wins ties). Host controls the track. |
| **Guest permission** | Guests can't load or play a track without host approval. Host sees a live request list. |
| **NTP clock sync** | Guests run a 4-way ping/pong handshake against the host to align a shared GMT clock. |
| **0.5s auto-drifter** | Every 500 ms a guest measures drift. ±10 ms deadband → speed nudge (0.998×–1.002×). ±60 ms → hard seek. |
| **Transport** | WebSocket relay (`/ws`) for cross-device Wi-Fi sync, BroadcastChannel fallback for same-browser tabs. |

## File structure

```
wavesync/
├── index.html        ← UI (open this in a browser)
├── style.css         ← Midnight-teal design system
├── app.js            ← UI controller
├── sync-engine.js    ← Sync engine: discovery, NTP, drifter, permissions
├── server.js         ← Zero-dependency Node relay (static + WebSocket /ws)
├── README.md
├── LICENSE           ← MIT
└── .gitignore
```

## Quick start

### Option A — Two or more devices on the same Wi-Fi (full sync)

1. **Install Node.js** (Termux: `pkg install nodejs-lts`).
2. Start the relay on one device:

   ```sh
   node server.js
   ```

3. It prints local URLs like `http://192.168.1.42:8080`.
4. Open that URL on every phone connected to the same Wi-Fi / hotspot.
   They join automatically — no codes.

### Option B — Single device / quick test

Just open `index.html` in a browser. Playback and UI work locally;
sync activates when a second tab/device connects.

## Building on Termux

```sh
pkg install nodejs-lts git
git clone https://github.com/DharshanS-code/WaveSync wavesync
cd wavesync
node server.js
```

No build step. No npm install. No dependencies.

## Technical details

### Clock sync (NTP-style)

A guest sends `ping` with `t1 = local time`. The host responds with
`pong` containing `t1`, `t2` (host receive), `t3` (host send). The
guest computes offset:

```
offset = (t2 - t1 + (t3 - t4)) / 2
```

Up to 7 samples are kept; the median is used as the clock offset.

### Auto-drifter

Every 500 ms a guest compares its audio position to the host's last
beat, adjusted for elapsed GMT time:

```
expected = beat.position + (now_gmt - beat.at_gmt)
drift    = audio.currentTime * 1000 - expected
```

| Drift | Action |
|---|---|
| `|drift| ≤ 10 ms` | No correction (deadband) |
| `10 < |drift| ≤ 60 ms` | Nudge `playbackRate` to 0.998× or 1.002× |
| `|drift| > 60 ms` | Hard seek + reset rate to 1.0× |

### Permission flow

```
Guest  →  req   →  Host
Host   →  perm  →  Guest (allow/deny)
Guest calls promote() → becomes new host
```

## License

MIT — see [LICENSE](LICENSE).

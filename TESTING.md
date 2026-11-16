# Testing and validation

## Automated suites

- `npm test`: pure protocol/room-state tests, Node WebSocket adapter integration, audio source lifecycle and correction math, clock calibration/duplicate rejection, network hints, queue/cache ownership, transfer serialization/malformed input and service-worker lifecycle.
- `npm run lint`: syntax, relative import paths and manifest assets.
- `npm run build`: content-derived static shell artifact and build report.
- `npm run test:browser`: separate real Chromium host/guest contexts, generated WAV bytes, actual local WebSocket signaling and WebRTC DataChannel transfer/decode, Web Audio sources, role separation, pause, playlist transition, reconnect, host departure, themes and narrow layout. Screenshots/report saved in ignored `test-results/`.

Generated WAV test audio is synthetic input, not fabricated synchronization evidence. Browser contexts on one machine do not establish acoustic timing accuracy across independent outputs.

## Physical-device acceptance matrix

Use at least two independent devices, record model/browser/OS, power/background state, connection topology and output route. For each condition run three repeatable sessions, including play/pause, seek, next-track, late join, disconnection/rejoin and host interruption:

| Dimension | Conditions |
| --- | --- |
| Wi-Fi | strong/weak reception, congestion, 2.4/5/6GHz where available |
| Browser | Android Chromium, iOS Safari, desktop Chromium/Firefox/Safari |
| Outputs | built-in speaker, wired, USB, Bluetooth |
| Lifecycle | foreground/background, lock screen, call interruption, audio resume |
| Network | same LAN, isolated client network, cross-NAT, outage/reconnection |
| Scale | 1, 3, 8 guests, low-end Android memory pressure |

Measure acoustic divergence with external synchronized recording or known loopback equipment. Record microphone geometry/propagation delay, stimulus, sample rate, duration, temperature/power state and measurement method. Report distribution and worst-case excursions, not a single favorable sample. Preserve raw recordings and conditions outside public source if sensitive.

Wi-Fi band/RSSI and congestion must come from verified native/OS/router instrumentation, not the web page. No synthetic label such as “weak Wi-Fi” is evidence of an actual weak wireless connection. Compare the baseline commit and re-engineered branch under the same conditions before claiming a real-world improvement.

## Currently unverified boundaries

Physical Android/iOS, real Wi-Fi bands/congestion, acoustic multi-device divergence, Bluetooth latency, low-memory decode peak, cross-NAT success, Cloudflare runtime deployment/object restart, PWA installation/update on physical devices, screen-reader behavior, and long background survival require external validation. Browser automated screenshots do not replace assistive-technology testing.

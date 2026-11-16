# Development

Use a modern Node runtime and Chromium for automated browser tests. Native ES modules need no transpilation. The only application development server dependency is `ws`; Playwright is a test-only dependency.

```bash
npm install --ignore-scripts
npm run dev
```

Open `http://localhost:3000`. The launcher starts static assets on port 3000 and signaling on 8787, both loopback-only. On another physical device, localhost refers to that device, not your laptop. For LAN devices use a trusted HTTPS reverse proxy and WSS endpoint, or deploy to your owned HTTPS/WSS infrastructure. Do not combine HTTPS app pages with plaintext `ws://`.

```bash
npm test
npm run lint
npm run build
npm run test:browser
```

`lint` currently checks JavaScript syntax, relative module paths, and manifest assets; it is not a full style/type linter. JavaScript is runtime-validated; there is no configured static typecheck. `build` copies allowlisted public files to `dist/` and embeds a content-derived coherent shell revision. It does not compile framework code.

## Android shared-storage / Debian PRoot test environment

Shared storage may reject executable symlinks. Use:

```bash
npm install --ignore-scripts --bin-links=false
WAVESYNC_PROOT_BROWSER=1 npm run test:browser
```

The flag adapts Termux Node's `android` platform report to the actual Linux Chromium test executable inside PRoot. It is confined to the test driver; it does not manufacture app Wi-Fi capabilities. Set `CHROMIUM_PATH` if Chromium is elsewhere. The test driver uses `--no-sandbox` for the root container; run it only with local test pages and explicit approval, never arbitrary browsing. This is not a recommended general deployment setting.

## Editing

Keep protocol validators shared between adapters. Never use queue position as track identity or interpolate filenames/peer names as HTML. Check session/selection/transport ownership after every asynchronous boundary. All transfer promises must settle on closure, timeout or failure. Preserve user-gesture audio activation; test permission-denied and interruption states.

Serve the source for development, but deploy the built `dist/` artifact. Rebuilding source-only deployments without a changed worker revision is not the supported production update workflow.

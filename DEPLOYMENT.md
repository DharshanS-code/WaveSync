# Deployment

Deploy only after reviewing the branch, testing the built artifact, and validating physical-device behavior. No production deployment or main-branch merge is part of the local engineering checks.

## Static frontend

```bash
npm install --ignore-scripts
npm test
npm run lint
npm run build
```

Ordinary builds default to **self-hosted** and publish to `dist/self-hosted/`. Explicit `npm run build:official` publishes to `dist/official/`. Upload **only the selected child directory**, never the parent `dist/` (which can contain historical legacy outputs), repository root, backend source, tests, credentials, `.git`, or node_modules. Manifest/shell URLs remain relative for subpaths. Serve `sw.js` without a long immutable browser cache and deploy the complete selected artifact atomically.

### Configure an independent deployment

Edit `config/deployment.json`: `signalUrl` is your own public `wss://…/api/room` endpoint; optional `operator` provides neutral operator text and `providerNote` explains the actual signaling/hosting providers. These settings are emitted as public JavaScript, so never put credentials there. Blank signaling is allowed: the app opens with a setup notice and disabled Create/Join plus an application guard. Invalid configured URLs fail the build. There is **no official endpoint fallback**. Run `npm run build` after changing settings.

The official endpoint is isolated in `official/deployment.json` and selected only by the explicit official profile. Public saved/query signaling overrides stay ignored; localhost retains test overrides. Invitations contain room codes, not private resume tokens. Default Google STUN discovery is separate from signaling: this change does not configure TURN or alter ICE protocols/credentials. Describe those providers in your operator note and review `CONFIG.iceServers` before changing discovery services.

Self-hosted artifacts structurally omit official support modules, routes, payment data, markup, styles, personal promotional identity and `config/features.json` fetching. Required MIT license/upstream attribution remains. Public Worker URLs cannot be secret; build separation prevents accidental reuse, not deliberate copying or service abuse. Strong authorization/origin/edge policy is separate backend/deployment work.

**Protocol migration:** this re-engineering changes track/timeline validation and recovery. Deploy the matching Worker before advertising the new frontend. An old public Worker may not implement the new welcome epoch/snapshot/resume protocol; production compatibility must be verified rather than assumed.

## Redesign release configuration

Each selected artifact is staged from an exact allowlist; the profile, generated public configuration, package version and emitted bytes determine its revision. The service-worker shell is generated from the same emitted inventory. `build-inventory.json` records SHA-256 file ownership: rebuilding replaces only verified build-owned contents, rejecting unexpected/modified files and symlinks rather than deleting unowned material. Inspect and preserve anything reported as modified before choosing a fresh empty output; do not bypass the inventory guard. The old parent `dist/` is not cleaned or published.

**Official only:** creator support is controlled by `config/features.json`. `true` enables it; `false`, missing/invalid config and failed/bounded fetches disable it. The runtime file is fetched with `no-store` and excluded from the SW cache. A served config edit takes effect on reload; a repository edit still needs its normal deployment. Disabling the official flag hides/blocks the view but is not structural removal; self-hosted packaging is the mechanism that excludes the implementation entirely.

Hash routes (`#home`, `#room`, `#settings`, `#privacy`, official-only `#support`) work under static subpaths without rewrite rules. Unknown/self-hosted support routes normalize to Home. Built metadata reports the real version, revision and profile.

## GitHub Pages release steps

The repository currently serves Pages from `main` at `/` using the legacy branch publisher. Switch to **Settings → Pages → Build and deployment → Source: GitHub Actions** before merging this release; otherwise the source tree, not the coherent built artifact, is published.

1. Review the PR and its build/test checks. Coordinate a maintenance window: the new protocol is not compatible with old frontend clients.
2. Deploy and verify the matching Cloudflare Worker from the PR branch (below). Do not advertise the new frontend before this step.
3. Switch the repository's Pages source to GitHub Actions. This setting change can be made through GitHub's web UI without storing a deployment token.
4. Merge the PR when ready. `.github/workflows/pages.yml` tests and builds on Ubuntu/Node 22, selects official only when `github.repository` exactly matches `DharshanS-code/WaveSync` (all forks select self-hosted), uploads only `dist/<selected-profile>/`, and publishes through the `github-pages` environment. PR runs verify but do not deploy.
5. Wait for **Verify and publish WaveSync** to finish. Confirm the Pages environment URL; the existing project URL is `https://dharshans-code.github.io/WaveSync/`.
6. Open the app in a fresh browser context, create/join on two devices, select an audio file, and verify playback/pause/reconnect. Existing PWA clients should leave their room before applying the update.

If `github-pages` environment approval is configured, approve the deployment in Actions. A manual workflow run on `main` can republish the latest verified artifact; runs on other branches do not deploy.

## Cloudflare dashboard deployment (phone)

1. Open `https://dash.cloudflare.com/` in your phone browser. Enable Desktop site if the editor is cramped.
2. Select the account containing the existing `wavesync-signal` Worker. Open **Workers & Pages → wavesync-signal → Edit code** (labels may vary).
3. Back up the currently deployed code/version so you can roll back. Do not create a different Worker or delete its Durable Object namespace.
4. Copy the entire generated `backend/dashboard-worker.js` file into the main module in the editor. The dashboard file is a single ES module with no local imports and exports both the default fetch handler and `RoomDO`. Do not paste the small unbundled `backend/worker.js` alone.
5. Check **Bindings** or **Settings → Bindings**: preserve the existing Durable Object binding named exactly **ROOMS**, targeting the existing **RoomDO** namespace. Keep the class name **RoomDO** and the existing migration/namespace. Do not create a new namespace or paid resource to solve a binding mismatch; stop and inspect the current configuration instead.
6. Select **Deploy** during a quiet period; active rooms can be interrupted. A preview is not a production deployment.
7. Open `https://wavesync-signal.dharshandcu.workers.dev/api/health`; expect `ok: true`. Health alone does not prove registration compatibility. Create/join a room in the updated frontend to verify the new welcome/epoch/token protocol.
8. Leave old rooms, reload both phones, and apply any waiting PWA update before testing audio.

The paste-ready file is generated from the maintained backend with `node scripts/bundle-worker.mjs`. A copy is also saved locally at `WaveSync/cloudflare-dashboard/worker.js`. If Cloudflare reports **ROOMS missing**, **RoomDO not found**, or a migration error, do not delete bindings; report the exact error/current binding screen. If the editor cannot replace an existing Durable Object class without a migration, use the existing deployed class/namespace and inspect its configuration first.

## Cloudflare Worker via Wrangler

Install the backend's pinned Wrangler with `npm --prefix backend install`, authenticate interactively, and inspect `backend/wrangler.toml` and account billing before deployment. Do not enable a paid plan without owner approval.

```bash
cd backend
npx --no-install wrangler login
npx --no-install wrangler deploy
```

Worker route: `/api/room?code=XXXXXX`, health: `/api/health`. One RoomDO per code. The Worker optionally supports an `ASSETS` binding, but it is not enabled by default. Set its directory to the selected built `../dist/self-hosted` or `../dist/official`, never the parent `../dist` or repository root, if you deliberately enable it.

RoomDO state is in-memory. A Worker/DO restart loses active rooms. Socket resume handles temporary network disconnects within the live runtime, not durable recovery across restarts. Verify Cloudflare plan/API compatibility and alarms in your actual account; local Node tests do not prove deployed-runtime behavior.

## Network/security checklist

- HTTPS app + WSS signaling; never HTTPS + plaintext ws.
- Validate shared protocol, host identity/role and host↔guest topology server-side.
- Set appropriate origin/edge abuse policy for your deployment. Per-socket limits are not global bot protection.
- No TURN/SFU is configured. STUN alone can fail across restrictive NATs/isolated wireless clients.
- Review app updates outside active rooms; do not force reload while transferring or playing.
- Keep `.env*`, tokens and infrastructure credentials out of git. Room codes permit accountless joining; do not treat them as strong authentication for sensitive sessions.
- Scale fanout conservatively; encoded upload multiplies by guest count.

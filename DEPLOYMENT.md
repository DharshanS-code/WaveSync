# Deployment

Deploy only after reviewing the branch, testing the built artifact, and validating physical-device behavior. No production deployment or main-branch merge is part of the local engineering checks.

## Static frontend

```bash
npm install --ignore-scripts
npm test
npm run lint
npm run build
```

Publish only `dist/` to your static HTTPS host (GitHub Pages/Cloudflare Pages or equivalent). Do not publish the repository root, backend source, tests, credentials, `.git`, or node_modules. Configure an appropriate app subpath; manifest/shell URLs are relative. Serve `sw.js` without a long immutable browser cache. Deploy the complete built directory atomically; its worker revision is a digest of all shell assets.

The production fallback remains the project's existing public endpoint `wss://wavesync-signal.dharshandcu.workers.dev/api/room`. It is not automatically changed by deploying your own Worker. Set your owned endpoint in Connection & appearance or a `?signal=wss://.../api/room` URL. Invitations include the actual endpoint so guests reach the same room service. Private resume tokens are never shared.

**Protocol migration:** this re-engineering changes track/timeline validation and recovery. Deploy the matching Worker before advertising the new frontend. An old public Worker may not implement the new welcome epoch/snapshot/resume protocol; production compatibility must be verified rather than assumed.

## GitHub Pages release steps

The repository currently serves Pages from `main` at `/` using the legacy branch publisher. Switch to **Settings → Pages → Build and deployment → Source: GitHub Actions** before merging this release; otherwise the source tree, not the coherent built artifact, is published.

1. Review the PR and its build/test checks. Coordinate a maintenance window: the new protocol is not compatible with old frontend clients.
2. Deploy and verify the matching Cloudflare Worker from the PR branch (below). Do not advertise the new frontend before this step.
3. Switch the repository's Pages source to GitHub Actions. This setting change can be made through GitHub's web UI without storing a deployment token.
4. Merge the PR when ready. `.github/workflows/pages.yml` tests and builds on Ubuntu/Node 22, uploads only `dist/`, and publishes through the `github-pages` environment. PR runs verify but do not deploy.
5. Wait for **Verify and publish WaveSync** to finish. Confirm the Pages environment URL; the existing project URL is `https://dharshans-code.github.io/WaveSync/`.
6. Open the app in a fresh browser context, create/join on two devices, select an audio file, and verify playback/pause/reconnect. Existing PWA clients should leave their room before applying the update.

If `github-pages` environment approval is configured, approve the deployment in Actions. A manual workflow run on `main` can republish the latest verified artifact; runs on other branches do not deploy.

## Cloudflare Worker

Install the backend's pinned Wrangler with `npm --prefix backend install`, authenticate interactively, and inspect `backend/wrangler.toml` and account billing before deployment. Do not enable a paid plan without owner approval.

```bash
cd backend
npx --no-install wrangler login
npx --no-install wrangler deploy
```

Worker route: `/api/room?code=XXXXXX`, health: `/api/health`. One RoomDO per code. The Worker optionally supports an `ASSETS` binding, but it is not enabled by default. Set its directory to the built `../dist`, not the repository root, if you deliberately enable it.

RoomDO state is in-memory. A Worker/DO restart loses active rooms. Socket resume handles temporary network disconnects within the live runtime, not durable recovery across restarts. Verify Cloudflare plan/API compatibility and alarms in your actual account; local Node tests do not prove deployed-runtime behavior.

## Network/security checklist

- HTTPS app + WSS signaling; never HTTPS + plaintext ws.
- Validate shared protocol, host identity/role and host↔guest topology server-side.
- Set appropriate origin/edge abuse policy for your deployment. Per-socket limits are not global bot protection.
- No TURN/SFU is configured. STUN alone can fail across restrictive NATs/isolated wireless clients.
- Review app updates outside active rooms; do not force reload while transferring or playing.
- Keep `.env*`, tokens and infrastructure credentials out of git. Room codes permit accountless joining; do not treat them as strong authentication for sensitive sessions.
- Scale fanout conservatively; encoded upload multiplies by guest count.

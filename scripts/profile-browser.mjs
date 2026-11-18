// Bounded QA of built profiles only. No installs, outside services, or source writes.
if (process.platform === 'android' && process.env.WAVESYNC_PROOT_BROWSER === '1') {
  Object.defineProperty(process, 'platform', { value: 'linux' });
}
const { chromium } = await import('playwright');
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createStaticServer } from './dev.mjs';
import { createDevServer } from '../backend/dev-server.js';
import { buildProfile } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(root, 'test-results', 'profile-motion');
const label = process.env.WAVESYNC_QA_RUN || 'report';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Use a simple report label.');
const caseFilter = process.env.WAVESYNC_QA_FILTER ? new RegExp(process.env.WAVESYNC_QA_FILTER, 'i') : null;
await mkdir(evidence, { recursive: true });
const directories = {
  generic: resolve(root, 'dist', 'self-hosted'),
  official: resolve(root, 'dist', 'official'),
  configured: resolve(evidence, 'configured-build')
};
// Rebuild selected owned outputs so evidence includes the latest approved teardown changes.
await buildProfile({ profile: 'self-hosted', output: directories.generic });
await buildProfile({ profile: 'official', output: directories.official });
await buildProfile({ profile: 'self-hosted', output: directories.configured,
  deployment: { signalUrl: 'wss://signal.independent.test/api/room', operator: 'Independent deployment' } });
const report = { status: 'running', startedAt: new Date().toISOString(), cases: [], screenshots: [],
  artifacts: {}, blockedTraffic: [], pageErrors: [], brokenAssets: [],
  limitations: ['Single headless Chromium on Linux in Android PRoot; no physical mobile/PWA installation or acoustic alignment validation.',
    'Service workers blocked; public HTTPS origins fulfilled entirely from local built files. Playwright registration resolves undefined, producing a visible caught offline-installation notice about reading waiting in an early dialog screenshot; no service-worker functionality claim.',
    'Public configured WebSocket endpoint is inspected, not contacted. Only real loopback signaling is allowed; ICE servers forced empty in QA.',
    'One short focused built-profile core flow; legacy browser suite separately exercises reconnect and playlist transitions.',
    'Channel/source continuity checked on the host because guest synchronization may legitimately replace sources for drift correction.'] };
const manifests = {};
for (const [profile, directory] of Object.entries(directories)) {
  const inventory = JSON.parse(await readFile(resolve(directory, 'build-inventory.json'), 'utf8'));
  manifests[profile] = new Set(Object.keys(inventory.files));
  report.artifacts[profile] = { directory, build: JSON.parse(await readFile(resolve(directory, 'build-info.json'), 'utf8')),
    testedHashes: Object.fromEntries(await Promise.all(['index.html', 'src/ui.js', 'src/motion.js', 'src/styles.css', 'src/app.js', 'src/deployment.js'].map(async name =>
      [name, createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex')])))};
}
const web = createStaticServer({ port: 0, directory: directories.generic });
const signal = createDevServer({ port: 0 });
await Promise.all([web, signal].map(s => s.listening ? Promise.resolve() : new Promise(r => s.once('listening', r))));
const origin = `http://127.0.0.1:${web.address().port}`;
const signalURL = `ws://127.0.0.1:${signal.address().port}/api/room`;
const localBase = `${origin}/?signal=${encodeURIComponent(signalURL)}`;
const publicOrigin = 'https://independent.test';
let browser;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
async function persist() {
  await writeFile(resolve(evidence, `${label}.json`), JSON.stringify(report, null, 2));
}
async function check(name, fn) {
  if (caseFilter && !caseFilter.test(name) && !name.startsWith('No uncaught')) return;
  const start = Date.now(); console.log(`START ${name}`);
  try { const observations = await fn(); report.cases.push({ name, status: 'pass', durationMs: Date.now() - start, observations }); console.log(`PASS ${name}`); }
  catch (error) { report.cases.push({ name, status: 'fail', durationMs: Date.now() - start, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`); }
  await persist();
}
async function context({ profile = 'generic', local = false, feature = true, viewport = { width: 390, height: 844 }, reduced = false, stored = false, standalone = false } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const requests = [], sockets = [];
  ctx.on('request', request => requests.push({ url: request.url(), type: request.resourceType() }));
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && local) return route.continue();
    if (url.origin !== publicOrigin || local) {
      report.blockedTraffic.push({ type: 'http', origin: url.origin }); return route.abort('blockedbyclient');
    }
    // Never proxy a fake public origin. Inventory, lexical and real-path containment reject traversal/symlinks.
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return route.fulfill({ status: 400, body: 'Invalid path' }); }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..') || !manifests[profile].has(name)) {
      return route.fulfill({ status: 404, body: 'Not found' });
    }
    if (profile === 'official' && name === 'config/features.json') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ supportCreator: feature }) });
    }
    const file = resolve(directories[profile], name), base = await realpath(directories[profile]);
    if (!file.startsWith(directories[profile] + sep) || (await lstat(file)).isSymbolicLink() || !(await realpath(file)).startsWith(base + sep)) {
      return route.fulfill({ status: 404, body: 'Not found' });
    }
    return route.fulfill({ contentType: mime[extname(file)] || 'text/plain', body: await readFile(file) });
  });
  assert.equal(typeof ctx.routeWebSocket, 'function', 'WebSocket routing is required for network isolation');
  await ctx.routeWebSocket('**/*', socket => {
    sockets.push(socket.url());
    const target = new URL(socket.url()), allowed = new URL(signalURL);
    if (local && target.origin === allowed.origin && target.pathname === allowed.pathname && !target.username && !target.password) socket.connectToServer();
    else { report.blockedTraffic.push({ type: 'websocket', origin: new URL(socket.url()).origin }); socket.close(); }
  });
  await ctx.addInitScript(({ stored, standalone }) => {
    if (stored && ['http:', 'https:'].includes(location.protocol)) localStorage.setItem('wavesync.settings', JSON.stringify({ reducedMotion: true }));
    if (standalone === 'navigator') Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    if (standalone === 'media') {
      const native = window.matchMedia.bind(window);
      window.matchMedia = query => query === '(display-mode: standalone)' ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} } : native(query);
    }
    const Native = window.RTCPeerConnection;
    if (Native) window.RTCPeerConnection = class extends Native { constructor(config, constraints) { super({ ...config, iceServers: [] }, constraints); } };
    window.__qaAnimations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      window.__qaAnimations.push({ id: this.id, frames, options });
      return animate.call(this, frames, options);
    };
    window.__qaFeatureSettled = false;
    const nativeFetch = window.fetch;
    window.fetch = (...args) => {
      const result = nativeFetch(...args);
      if (String(args[0]).includes('config/features.json')) result.then(async r => {
        try { await r.clone().text(); } finally { window.__qaFeatureSettled = true; }
      }, () => { window.__qaFeatureSettled = true; });
      return result;
    };
  }, { stored, standalone });
  ctx.on('page', page => {
    page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', error => report.pageErrors.push({ message: error.message, url: page.url() }));
    page.on('response', response => { if (response.status() >= 400 && /\.(js|css|png|svg)$/.test(new URL(response.url()).pathname)) report.brokenAssets.push(response.url()); });
  });
  ctx.qa = { requests, sockets, profile, local };
  return ctx;
}
class BuiltPage {
  constructor(page) { this.page = page; }
  async ready(hash = 'home') {
    const ctx = this.page.context();
    await this.page.goto(`${ctx.qa.local ? localBase : publicOrigin + '/'}#${hash}`, { waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(() => !!window.wavesync);
    if (ctx.qa.profile === 'official') {
      await this.page.waitForFunction(() => window.__qaFeatureSettled);
      await this.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
  }
  async nav(route) {
    return this.page.evaluate(async route => {
      if (location.hash !== '#' + route) {
        await new Promise(r => { window.addEventListener('hashchange', r, { once: true }); location.hash = route; });
      }
      const screen = document.getElementById(`${route}-screen`);
      return { route: window.wavesync.ui.view, hash: location.hash, animations: screen.getAnimations().map(a => ({ state: a.playState, frames: a.effect.getKeyframes() })) };
    }, route);
  }
  async settled() {
    await this.page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' && a.playState !== 'pending'));
    await this.page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(r)); });
  }
  async shot(name) {
    await this.settled(); const path = resolve(evidence, `${label}-${name}.png`);
    await this.page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  }
}
async function using(options, fn) {
  const ctx = await context(options);
  try { const page = await ctx.newPage(); return await fn(new BuiltPage(page), ctx); }
  finally { await ctx.close(); }
}
async function activeScreen(page, route) {
  assert.deepEqual(await page.locator('[data-screen]:not([hidden])').evaluateAll(es => es.map(e => e.dataset.screen)), [route]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
function wav() {
  const rate = 8000, seconds = 24, channels = 2, frames = rate * seconds;
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * (c ? 660 : 440)) * 5000), 44 + (i * channels + c) * 2);
  return bytes;
}
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  report.browserVersion = browser.version();
  await check('Generic public missing endpoint: setup, disabled controls, guarded programmatic connect, no owner requests', () => using({}, async (p, ctx) => {
    await p.ready('support'); await p.settled();
    assert.equal(await p.page.evaluate(() => location.hash), '#home');
    assert.equal(await p.page.locator('#signaling-setup').isVisible(), true);
    assert.equal(await p.page.locator('#create-room').isDisabled(), true);
    assert.equal(await p.page.locator('#join-room').isDisabled(), true);
    const observation = await p.page.evaluate(async () => {
      const errors = [];
      for (const role of ['host', 'guest']) try { await window.wavesync.connect('ABCDEF', role, 'Local QA'); } catch (error) { errors.push(error.message); }
      return { errors, signal: window.wavesync.signal, endpoint: window.wavesync.state.signalUrl, role: window.wavesync.state.role };
    });
    assert.equal(observation.endpoint, ''); assert.equal(observation.signal, null); assert.equal(observation.role, null);
    assert.equal(observation.errors.length, 2); assert.ok(observation.errors.every(e => /signaling server/.test(e)));
    assert.deepEqual(ctx.qa.sockets, []);
    assert.ok(ctx.qa.requests.every(r => new URL(r.url).origin === publicOrigin));
    assert.ok(!ctx.qa.requests.some(r => /official\/|support\.(js|css)|config\/features/.test(r.url)));
    assert.equal(await p.page.locator('#support-screen,[data-support-entry],[href^="upi:"]').count(), 0);
    const styles = await p.page.evaluate(() => [...document.styleSheets].map(s => s.href));
    assert.ok(styles.every(s => !s?.includes('support')));
    await p.shot('generic-missing-endpoint');
    await p.nav('settings');
    const license = p.page.getByRole('link', { name: 'License & source attribution' });
    assert.equal(await license.isVisible(), true); await license.focus();
    assert.equal(await license.evaluate(e => e === document.activeElement), true);
    const content = await p.page.evaluate(async () => (await fetch('./LICENSE')).text()); assert.match(content, /MIT License/);
    return { ...observation, licenseKeyboardAccessible: true, requests: ctx.qa.requests.map(r => new URL(r.url).pathname) };
  }));
  await check('Generic artifact contains no support imports, CSS or payment strings', async () => {
    const offenders = [];
    for (const name of manifests.generic) {
      assert.ok(!/^official\//.test(name), name);
      if (!/\.(html|js|css|json)$/.test(name)) continue;
      const text = await readFile(resolve(directories.generic, name), 'utf8');
      if (/supportCreator|support-screen|support\.css|upi:|payment|donation|@nyes/i.test(text)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], `Generic commerce strings in ${offenders.join(', ')}`);
    return { checkedFiles: manifests.generic.size };
  });
  await check('Configured generic public artifact enables controls without owner or signal requests', () => using({ profile: 'configured' }, async (p, ctx) => {
    await p.ready();
    assert.equal(await p.page.locator('#create-room').isEnabled(), true);
    assert.equal(await p.page.locator('#join-room').isEnabled(), true);
    assert.equal(await p.page.locator('#signaling-setup').isVisible(), false);
    assert.equal(await p.page.evaluate(() => window.wavesync.state.signalUrl), 'wss://signal.independent.test/api/room');
    assert.deepEqual(ctx.qa.sockets, []);
    assert.ok(ctx.qa.requests.every(r => new URL(r.url).origin === publicOrigin));
    return { configuredEndpointInspectedOnly: true };
  }));
  for (const feature of [true, false]) await check(`Official support flag ${feature}: route registration and direct URL refresh`, () => using({ profile: 'official', feature, viewport: { width: 1440, height: 900 } }, async (p, ctx) => {
    await p.ready('support');
    if (feature) await p.page.waitForFunction(() => window.wavesync.ui.routes.has('support'));
    assert.equal(await p.page.evaluate(() => window.wavesync.ui.routes.has('support')), feature);
    assert.equal(await p.page.evaluate(() => window.wavesync.ui.view), feature ? 'support' : 'home');
    assert.equal(await p.page.locator('#support-screen').isVisible(), feature);
    assert.equal(await p.page.locator('[data-support-entry]:visible').count(), feature ? 1 : 0);
    await p.shot(`official-support-${feature}`);
    await p.page.reload(); await p.page.waitForFunction(() => window.wavesync && window.__qaFeatureSettled);
    if (feature) await p.page.waitForFunction(() => window.wavesync.ui.routes.has('support'));
    assert.equal(await p.page.evaluate(() => window.wavesync.ui.view), feature ? 'support' : 'home');
    assert.deepEqual(ctx.qa.sockets, []);
    return { enabled: feature, directRouteAndRefresh: true };
  }));
  await check('Page entry motion on home/settings/privacy/home and second visits; rapid navigation cleanup', () => using({}, async p => {
    await p.ready(); await p.settled(); const observations = [];
    for (const route of ['settings', 'privacy', 'home', 'settings', 'privacy', 'home']) {
      const observed = await p.nav(route); observations.push(observed);
      assert.equal(observed.hash, '#' + route); assert.equal(observed.route, route);
      assert.ok(observed.animations.some(a => a.state === 'running' || a.state === 'pending'), `${route} entry absent`);
      await p.settled(); await activeScreen(p.page, route);
    }
    const rapid = await p.page.evaluate(() => {
      for (const route of ['settings', 'privacy', 'settings', 'home']) window.wavesync.ui.navigate(route);
      return [...document.querySelectorAll('[data-screen]')].map(e => ({ route: e.dataset.screen, hidden: e.hidden, animations: e.getAnimations().length }));
    });
    assert.ok(rapid.filter(e => e.hidden).every(e => e.animations === 0));
    await p.settled(); await activeScreen(p.page, 'home');
    return { visits: observations, rapid };
  }));
  await check('Drawer entry/exit/reopen cancellation, backdrop pointer policy, inert, focus trap and restoration', () => using({}, async p => {
    await p.ready(); await p.page.locator('#nav-open').click();
    await p.page.waitForFunction(() => document.activeElement.id === 'nav-close');
    assert.equal(await p.page.locator('#main-content').evaluate(e => e.inert), true);
    for (let i = 0; i < 7; i++) { await p.page.keyboard.press(i === 0 ? 'Shift+Tab' : 'Tab'); assert.equal(await p.page.evaluate(() => !!document.activeElement.closest('#sidebar')), true); }
    await p.shot('drawer-open');
    const cancellation = await p.page.evaluate(() => {
      const ui = window.wavesync.ui; ui._closeDrawer();
      const closing = { inert: document.getElementById('sidebar').inert, pointer: document.getElementById('nav-backdrop').style.pointerEvents, focus: document.activeElement.id };
      document.getElementById('nav-open').focus(); ui._openDrawer();
      return { closing, reopened: { inert: document.getElementById('sidebar').inert, pointer: document.getElementById('nav-backdrop').style.pointerEvents } };
    });
    assert.deepEqual(cancellation.closing, { inert: true, pointer: 'none', focus: 'nav-open' });
    assert.deepEqual(cancellation.reopened, { inert: false, pointer: '' });
    await p.settled(); assert.equal(await p.page.locator('#nav-backdrop').isVisible(), true);
    assert.equal(await p.page.evaluate(() => window.wavesync.ui.drawerOpen), true);
    await p.page.keyboard.press('Escape'); await p.settled();
    assert.equal(await p.page.locator('#nav-backdrop').isVisible(), false);
    assert.equal(await p.page.locator('#main-content').evaluate(e => e.inert), false);
    assert.equal(await p.page.evaluate(() => document.activeElement.id), 'nav-open');
    await p.page.locator('#nav-open').click(); await p.settled(); await p.page.mouse.click(380, 420); await p.settled();
    assert.equal(await p.page.evaluate(() => window.wavesync.ui.drawerOpen), false);
    assert.equal(await p.page.evaluate(() => document.activeElement.id), 'nav-open');
    return cancellation;
  }));
  await check('Confirmation dialog confirm/cancel/Escape/backdrop, repeated entries, Tab containment and focus restore', () => using({}, async p => {
    await p.ready(); await p.nav('settings'); await p.settled(); const observations = [];
    for (const action of ['confirm', 'cancel', 'Escape', 'backdrop']) {
      await p.page.locator('#theme-select').focus();
      const entry = await p.page.evaluate(() => {
        window.__qaDialogResult = 'pending';
        window.wavesync.ui.confirm('Local test confirmation', 'No stored data will be modified.').then(value => { window.__qaDialogResult = value; });
        return document.getElementById('confirm-dialog').getAnimations().length;
      });
      assert.ok(entry > 0, `${action}: entry absent`);
      for (let i = 0; i < 5; i++) { await p.page.keyboard.press(i === 0 ? 'Shift+Tab' : 'Tab'); assert.equal(await p.page.evaluate(() => !!document.activeElement.closest('#confirm-dialog')), true); }
      if (action === 'confirm') await p.shot('dialog');
      if (action === 'Escape') await p.page.keyboard.press('Escape');
      else if (action === 'backdrop') await p.page.mouse.click(4, 4);
      else await p.page.locator(`#confirm-dialog button[value="${action}"]`).click();
      await p.page.waitForFunction(() => window.__qaDialogResult !== 'pending'); await p.settled();
      const result = await p.page.evaluate(() => ({ result: window.__qaDialogResult, focus: document.activeElement.id, open: document.getElementById('confirm-dialog').open }));
      assert.deepEqual(result, { result: action === 'confirm', focus: 'theme-select', open: false }); observations.push({ action, ...result });
    }
    return observations;
  }));
  for (const mode of ['os', 'stored']) await check(`Reduced motion ${mode}: no active Web Animations or pressed transforms`, () => using({ reduced: mode === 'os', stored: mode === 'stored', standalone: 'media' }, async p => {
    await p.ready(); await p.settled();
    for (const route of ['settings', 'privacy', 'home']) { const observed = await p.nav(route); assert.deepEqual(observed.animations, []); }
    const start = await p.page.evaluate(() => window.__qaAnimations.length);
    await p.page.locator('#nav-open').click(); await p.settled(); await p.page.keyboard.press('Escape'); await p.settled();
    await p.nav('settings');
    await p.page.evaluate(() => { window.__qaDialogResult = 'pending'; window.wavesync.ui.confirm('Reduced test', 'Cancel only.').then(r => { window.__qaDialogResult = r; }); });
    await p.page.keyboard.press('Escape'); await p.page.waitForFunction(() => window.__qaDialogResult === false);
    assert.equal(await p.page.evaluate(() => window.__qaAnimations.length), start);
    await p.nav('home');
    const button = p.page.locator('#nav-open'), bounds = await button.boundingBox();
    await p.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await p.page.mouse.down();
    assert.equal(await button.evaluate(e => getComputedStyle(e).transform), 'none'); await p.page.mouse.up();
    await p.page.keyboard.press('Escape');
    assert.equal(await p.page.evaluate(() => document.getAnimations().length), 0);
    return { preference: mode, animationsAtStartup: start, subsequentAnimationCalls: 0, pressedTransform: 'none' };
  }));
  for (const standalone of ['media', 'navigator']) await check(`Standalone ${standalone}: launch once and controls remain nonblocking`, () => using({ standalone, local: true }, async p => {
    await p.ready(); await p.settled();
    assert.equal(await p.page.evaluate(() => window.__qaAnimations.filter(a => a.id === 'main-content').length), 1);
    assert.equal(await p.page.locator('#create-room').isEnabled(), true);
    await p.page.locator('#nav-open').click(); await p.page.keyboard.press('Escape'); await p.settled();
    await p.nav('settings'); await p.nav('privacy'); await p.nav('home'); await p.settled();
    assert.equal(await p.page.evaluate(() => window.__qaAnimations.filter(a => a.id === 'main-content').length), 1);
    const repeat = await p.page.evaluate(async () => {
      const { animateEntry } = await import('./src/motion.js');
      const controller = animateEntry(document.getElementById('main-content'), 'launch');
      return { settled: controller.settled, animation: !!controller.animation };
    });
    assert.deepEqual(repeat, { settled: true, animation: false });
    return { launchCalls: 1, repeat };
  }));
  await check('Approved teardown cleans active drawer/dialog motions and official extensions', async () => {
    const observations = [];
    for (const profile of ['generic', 'official']) observations.push(await using({ profile }, async p => {
      await p.ready(); await p.page.locator('#nav-open').click();
      await p.page.evaluate(() => {
        window.__qaDialogResult = 'pending';
        window.wavesync.ui.confirm('Teardown test', 'No data modified.').then(r => { window.__qaDialogResult = r; });
      });
      await p.page.evaluate(() => {
        window.wavesync.ui._dismissConfirmation('confirm');
        return window.wavesync.destroy();
      });
      await p.page.waitForFunction(() => window.__qaDialogResult === false);
      const observation = await p.page.evaluate(() => ({
        animations: document.getAnimations().filter(a => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).length, backdropHidden: document.getElementById('nav-backdrop').hidden,
        mainInert: document.getElementById('main-content').inert, headerInert: document.querySelector('.mobile-header').inert,
        dialogOpen: document.getElementById('confirm-dialog').open, drawerOpen: !!window.wavesync.ui.drawerOpen,
        supportRoute: window.wavesync.ui.routes.has('support'), extensionsMounted: (window.wavesync.extensions || []).some(e => e.mounted),
        overflow: document.body.style.overflow
      }));
      report.teardownDiagnostics ||= [];
      report.teardownDiagnostics.push({ profile, observation, animations: await p.page.evaluate(() => document.getAnimations().map(a => ({
        type: a.constructor.name, target: a.effect?.target?.id, property: a.transitionProperty, state: a.playState, frames: a.effect?.getKeyframes()
      }))) });
      assert.deepEqual(observation, { animations: 0, backdropHidden: true, mainInert: false, headerInert: false,
        dialogOpen: false, drawerOpen: false, supportRoute: false, extensionsMounted: false, overflow: '' });
      return { profile, ...observation };
    }));
    return observations;
  });
  await check('Delayed official feature response after app teardown cannot mount support', () => using({ profile: 'official' }, async p => {
    let pendingRoute;
    await p.page.route('**/config/features.json', route => { pendingRoute = route; });
    await p.page.goto(publicOrigin + '/#support', { waitUntil: 'domcontentloaded' });
    await p.page.waitForFunction(() => !!window.wavesync);
    assert.ok(pendingRoute, 'Hold actual same-origin feature response');
    await p.page.evaluate(() => window.wavesync.destroy());
    await pendingRoute.fulfill({ contentType: 'application/json', body: '{"supportCreator":true}' });
    await p.page.waitForFunction(() => window.__qaFeatureSettled);
    await p.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const observation = await p.page.evaluate(() => ({ destroyed: window.wavesync.destroyed, route: window.wavesync.ui.routes.has('support'),
      extensions: (window.wavesync.extensions || []).length, entries: [...document.querySelectorAll('[data-support-entry]')].filter(e => !e.hidden).length }));
    assert.deepEqual(observation, { destroyed: true, route: false, extensions: 0, entries: 0 });
    return observation;
  }));
  await check('Built generic screenshots both themes at 390/1440 and 320/768 overflow', () => using({}, async p => {
    await p.ready(); const observations = [];
    for (const width of [390, 1440, 320, 768]) {
      await p.page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      for (const theme of ['light', 'dark']) {
        await p.nav('settings'); await p.page.locator('#theme-select').selectOption(theme);
        await p.nav('home'); await p.settled(); await activeScreen(p.page, 'home');
        if ([390, 1440].includes(width)) await p.shot(`generic-home-${width}x${width === 1440 ? 900 : 844}-${theme}`);
        await p.nav('settings'); await p.settled(); await activeScreen(p.page, 'settings');
        if ([390, 1440].includes(width)) await p.shot(`generic-settings-${width}x${width === 1440 ? 900 : 844}-${theme}`);
        await p.nav('privacy'); await p.settled(); await activeScreen(p.page, 'privacy');
        observations.push({ width, theme, overflow: false });
      }
    }
    return observations;
  }));
  await check('Built generic real local WebSocket/WebRTC WAV transfer, play/pause, navigation and source/channel continuity', async () => {
    const hostCtx = await context({ local: true, viewport: { width: 1440, height: 900 } }), guestCtx = await context({ local: true });
    try {
      const host = new BuiltPage(await hostCtx.newPage()), guest = new BuiltPage(await guestCtx.newPage());
      await host.ready(); await guest.ready();
      assert.equal(await host.page.evaluate(() => window.wavesync.state.signalUrl), signalURL);
      await host.page.locator('#display-name').fill('Local host'); await host.page.locator('#create-room').click();
      await host.page.waitForFunction(() => window.wavesync.epoch && window.wavesync.signal.clock.synced);
      const code = await host.page.evaluate(() => window.wavesync.state.code);
      await guest.page.locator('#join-code').fill(code); await guest.page.locator('#join-room').click();
      await guest.page.waitForFunction(() => window.wavesync.epoch && window.wavesync.signal.clock.synced);
      await host.page.locator('#audio-files').setInputFiles({ name: 'Local stereo tone.wav', mimeType: 'audio/wav', buffer: wav() });
      await host.page.waitForFunction(() => window.wavesync.activeId && !window.wavesync.state.loading);
      await guest.page.waitForFunction(() => window.wavesync.cache.get(window.wavesync.activeId), null, { timeout: 20000 });
      await host.page.locator('#play-toggle').click(); await guest.page.waitForFunction(() => window.wavesync.audio.playing);
      await host.page.evaluate(() => {
        const app = window.wavesync;
        window.__qaCore = { source: app.audio.source, signal: app.signal, channels: [...app.peers.peers.values()].map(p => p.dc), track: app.activeId };
      });
      await host.nav('settings'); await host.page.locator('#channel-enabled').check(); await host.nav('room');
      await host.page.locator('#player-channel').selectOption('left');
      for (const route of ['settings', 'privacy', 'home', 'room']) { await host.nav(route); await host.settled(); }
      const continuity = await host.page.evaluate(() => {
        const app = window.wavesync, before = window.__qaCore;
        return { sourceSame: before.source === app.audio.source, signalSame: before.signal === app.signal, playing: app.audio.playing,
          channelsSame: before.channels.every(dc => [...app.peers.peers.values()].some(p => p.dc === dc && dc.readyState === 'open')),
          trackSame: before.track === app.activeId, channel: app.audio.channelMode, stereo: app.audio.buffer.numberOfChannels };
      });
      assert.deepEqual(continuity, { sourceSame: true, signalSame: true, playing: true, channelsSame: true, trackSame: true, channel: 'left', stereo: 2 });
      await guest.nav('settings'); await guest.nav('privacy'); await guest.nav('room');
      assert.equal(await guest.page.evaluate(() => window.wavesync.audio.playing), true);
      await host.shot('core-host-playing'); await guest.shot('core-guest-playing');
      await host.page.locator('#play-toggle').click(); await guest.page.waitForFunction(() => !window.wavesync.audio.playing);
      assert.equal(await host.page.evaluate(() => window.wavesync.audio.playing), false);
      assert.equal(await guest.page.locator('[data-host-only]:visible').count(), 0);
      assert.ok([...hostCtx.qa.sockets, ...guestCtx.qa.sockets].every(url => {
        const socket = new URL(url), allowed = new URL(signalURL);
        return socket.origin === allowed.origin && socket.pathname === allowed.pathname;
      }));
      await guest.page.evaluate(() => window.wavesync.leave()); await host.page.evaluate(() => window.wavesync.leave());
      return { continuity, transport: 'real loopback WebSocket and WebRTC DataChannel', pauseReachesGuest: true };
    } finally { await hostCtx.close(); await guestCtx.close(); }
  });
  await check('No uncaught page errors, broken assets or attempted remote network traffic', async () => {
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.brokenAssets, []); assert.deepEqual(report.blockedTraffic, []);
    return { uncaughtErrors: 0, brokenAssets: 0, remoteAttempts: 0 };
  });
  report.status = report.cases.every(c => c.status === 'pass') ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.error = error.stack; }
finally {
  report.finishedAt = new Date().toISOString(); await persist();
  const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  await writeFile(resolve(evidence, `${label}.xml`), `<testsuite name="built-profile-motion" tests="${report.cases.length}" failures="${report.cases.filter(c => c.status === 'fail').length}">${report.cases.map(c => `<testcase name="${xml(c.name)}" time="${c.durationMs / 1000}">${c.status === 'fail' ? `<failure>${xml(c.error)}</failure>` : ''}</testcase>`).join('')}</testsuite>\n`);
  console.log(JSON.stringify({ status: report.status, cases: report.cases.map(({ name, status }) => ({ name, status })), report: resolve(evidence, `${label}.json`) }, null, 2));
  await browser?.close(); await Promise.all([web, signal].map(s => new Promise(r => s.close(r))));
}
if (report.status !== 'pass') process.exitCode = 1;

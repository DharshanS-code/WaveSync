// Real local-browser redesign QA. No installs, external services or production writes.
if (process.platform === 'android' && process.env.WAVESYNC_PROOT_BROWSER === '1') {
  Object.defineProperty(process, 'platform', { value: 'linux' });
}
const { chromium } = await import('playwright');
import { createStaticServer } from './dev.mjs';
import { buildProfile } from './build.mjs';
import { createDevServer } from '../backend/dev-server.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(root, 'test-results', 'redesign');
const runLabel = process.env.WAVESYNC_QA_RUN || 'report';
if (!/^[a-z0-9-]+$/.test(runLabel)) throw new Error('Use a simple local report label.');
const caseFilter = process.env.WAVESYNC_QA_FILTER ? new RegExp(process.env.WAVESYNC_QA_FILTER, 'i') : null;
await mkdir(evidence, { recursive: true });
await buildProfile({ profile: 'official' });
const web = createStaticServer({ port: 0, directory: resolve(root, 'dist', 'official') }), signal = createDevServer({ port: 0 });
await Promise.all([web, signal].map(s => s.listening ? Promise.resolve() : new Promise(r => s.once('listening', r))));
const origin = `http://127.0.0.1:${web.address().port}`;
const signalURL = `ws://127.0.0.1:${signal.address().port}/api/room`;
const base = `${origin}/?signal=${encodeURIComponent(signalURL)}`;
const report = { status: 'running', startedAt: new Date().toISOString(), cases: [], screenshots: [], audits: [], metrics: [], blockedExternal: [], pageErrors: [], brokenAssets: [], limitations: ['Single headless Linux Chromium in Android PRoot, not physical Android/iOS or Bluetooth/Wi-Fi/acoustic tests.', 'Service workers blocked; no payment app launched, no payment made.', 'Offline audio samples validate the actual production graph, not physical speaker output.'] };
let browser;
async function persist() { await writeFile(resolve(evidence, `${runLabel}.json`), JSON.stringify(report, null, 2)); }
async function check(name, fn) {
  if (caseFilter && !caseFilter.test(name) && !name.startsWith('No page errors')) return;
  const start = Date.now();
  console.log(`START ${name}`);
  try { const observations = await fn(); report.cases.push({ name, status: 'pass', durationMs: Date.now() - start, observations }); console.log(`PASS ${name}`); }
  catch (error) { report.cases.push({ name, status: 'fail', durationMs: Date.now() - start, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`); }
  await persist();
}
async function context(feature = 'true', viewport = { width: 390, height: 844 }, seed = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { report.blockedExternal.push({ type: 'http', origin: url.origin }); return route.abort('blockedbyclient'); }
    if (url.pathname === '/config/features.json' && feature !== 'native') {
      if (feature === 'failure') return route.abort('failed');
      const bodies = { true: '{"supportCreator":true}', false: '{"supportCreator":false}', missing: '{}', malformed: '{', string: '{"supportCreator":"true"}', null: 'null' };
      return route.fulfill({ status: feature === 'http-error' ? 503 : 200, contentType: 'application/json', body: bodies[feature] ?? '{}' });
    }
    return route.continue();
  });
  if (ctx.routeWebSocket) await ctx.routeWebSocket('**/*', socket => {
    if (socket.url().startsWith(signalURL)) socket.connectToServer();
    else { report.blockedExternal.push({ type: 'websocket', origin: new URL(socket.url()).origin }); socket.close(); }
  });
  await ctx.addInitScript(seedValues => {
    if (['http:', 'https:'].includes(location.protocol)) {
      try { for (const [key, value] of Object.entries(seedValues)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }
      catch { window.__qaSeedStorageUnavailable = true; }
    }
    // Prevent Chromium's ICE implementation from contacting public STUN; host candidates remain real.
    const Native = window.RTCPeerConnection;
    if (Native) window.RTCPeerConnection = class extends Native {
      constructor(config, constraints) { super({ ...config, iceServers: [] }, constraints); }
    };
    const originalFetch = window.fetch;
    window.fetch = (...args) => {
      const result = originalFetch(...args);
      if (String(args[0]).includes('config/features.json')) {
        window.__qaFeatureSettled = false;
        result.then(async r => { try { await r.clone().text(); } finally { window.__qaFeatureSettled = true; } }, () => { window.__qaFeatureSettled = true; });
      }
      return result;
    };
    window.__qaMetrics = { supported: [], cls: 0, layoutShifts: [], longTasks: [] };
    for (const type of ['layout-shift', 'longtask']) {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
      window.__qaMetrics.supported.push(type);
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (type === 'layout-shift') {
            if (!entry.hadRecentInput) window.__qaMetrics.cls += entry.value;
            window.__qaMetrics.layoutShifts.push({ value: entry.value, hadRecentInput: entry.hadRecentInput, startTime: entry.startTime });
          } else window.__qaMetrics.longTasks.push({ duration: entry.duration, startTime: entry.startTime });
        }
      }).observe({ type, buffered: true });
    }
  }, seed);
  ctx.on('page', page => {
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', e => report.pageErrors.push({ page: page.url(), message: e.message }));
    page.on('response', r => {
      const path = new URL(r.url()).pathname;
      if (r.status() >= 400 && /\.(?:js|css|svg|png|jpg|woff2?)$/.test(path)) report.brokenAssets.push({ path, status: r.status() });
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (url.origin === origin && /\.(?:js|css|svg|png|jpg|woff2?)$/.test(url.pathname)) report.brokenAssets.push({ path: url.pathname, error: request.failure()?.errorText });
    });
  });
  return ctx;
}
async function ready(page, hash = 'home') {
  await page.goto(`${base}#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.wavesync && window.__qaFeatureSettled === true);
  await settle(page);
}
async function settle(page) { await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }); }
class Navigation {
  constructor(page) { this.page = page; }
  async hash(route) {
    await this.page.evaluate(route => { location.hash = route; }, route);
    await this.page.waitForFunction(route => window.wavesync.ui.view === route.split('/')[0], route);
    await settle(this.page);
  }
  async link(route) {
    if ((await this.page.viewportSize()).width < 960) await this.page.locator('#nav-open').click();
    await this.page.locator(`#sidebar [data-route="${route}"]`).click();
    await this.page.waitForFunction(route => window.wavesync.ui.view === route, route);
    await settle(this.page);
  }
}
async function audit(page, label) {
  const observed = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
    const brokenImages = [...document.images].filter(e => e.complete && e.naturalWidth === 0).map(e => e.getAttribute('src'));
    const fakeLinks = [...document.querySelectorAll('a[href]')].filter(e => e.getClientRects().length && /^(?:#|javascript:|\s*)$/.test(e.getAttribute('href'))).map(e => ({ id: e.id, text: e.textContent.trim() }));
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i), brokenImages, fakeLinks, activeScreens: [...document.querySelectorAll('[data-screen]:not([hidden])')].map(e => e.dataset.screen), footerVisible: !!document.getElementById('home-footer').getClientRects().length, productScreen: window.wavesync.state.screen, visualRoute: window.wavesync.ui.view };
  });
  report.audits.push({ label, ...observed });
  assert.ok(observed.scrollWidth <= observed.width, `${label}: horizontal overflow ${observed.scrollWidth}/${observed.width}`);
  assert.deepEqual(observed.duplicateIds, [], `${label}: duplicate IDs`);
  assert.deepEqual(observed.brokenImages, [], `${label}: broken images`);
  assert.deepEqual(observed.fakeLinks, [], `${label}: fake links`);
  assert.deepEqual(observed.activeScreens, [observed.visualRoute]);
  assert.equal(observed.footerVisible, observed.visualRoute === 'home', `${label}: Home footer visibility`);
}
async function screenshot(page, label) {
  await settle(page);
  const path = resolve(evidence, `${label}.png`);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
}
async function range(page, selector, value) {
  await page.locator(selector).evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}
function wav(seconds = 30, stereo = true) {
  const rate = 8000, channels = stereo ? 2 : 1, frames = rate * seconds, bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * (c ? 660 : 440)) * 6000), 44 + (i * channels + c) * 2);
  return bytes;
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  report.browserVersion = browser.version();
  report.sourceHashes = {};
  for (const file of ['index.html', 'src/ui.js', 'src/styles.css', 'src/app.js', 'src/settings-controller.js', 'src/audio-engine.js', 'src/preferences.js', 'src/features.js', 'src/sync-engine.js', 'scripts/dev.mjs']) {
    report.sourceHashes[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
  }
  for (const flag of ['native', 'true', 'false', 'missing', 'malformed', 'string', 'null', 'http-error', 'failure']) await check(`Feature flag ${flag}, direct Support URL and refresh`, async () => {
    const ctx = await context(flag, { width: 1440, height: 900 });
    try {
      const page = await ctx.newPage(); await ready(page, 'support');
      const expected = flag === 'true' || flag === 'native';
      assert.equal(await page.evaluate(() => window.wavesync.ui.routes.has('support')), expected);
      assert.equal(await page.evaluate(() => window.wavesync.ui.view), expected ? 'support' : 'home');
      assert.equal(await page.locator('[data-support-entry]:visible').count(), expected ? 1 : 0);
      assert.equal(await page.locator('#support-screen').isVisible(), expected);
      await page.reload(); await page.waitForFunction(() => window.wavesync && window.__qaFeatureSettled); await settle(page);
      assert.equal(await page.evaluate(() => window.wavesync.ui.view), expected ? 'support' : 'home');
      await audit(page, `flag-${flag}`);
      return { supportEnabled: expected, directURL: true, refresh: true };
    } finally { await ctx.close(); }
  });
  await check('Delayed feature response does not hijack navigation away from initial Support route', async () => {
    const ctx = await context('true', { width: 1440, height: 900 });
    try {
      const page = await ctx.newPage(); let pendingRoute;
      await page.route('**/config/features.json', route => { pendingRoute = route; });
      await page.goto(`${base}#support`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.wavesync); await settle(page);
      await page.locator('#sidebar [data-route="settings"]').click();
      assert.ok(pendingRoute, 'Feature request must be held before response');
      await pendingRoute.fulfill({ contentType: 'application/json', body: '{"supportCreator":true}' });
      await page.waitForFunction(() => window.wavesync.ui.routes.has('support'));
      assert.equal(await page.evaluate(() => window.wavesync.ui.view), 'settings');
      assert.equal(new URL(page.url()).hash, '#settings');
      return { delayedConfig: 'intercepted until actual Settings navigation', finalRoute: 'settings' };
    } finally { await ctx.close(); }
  });
  await check('Actual Home/sidebar links, direct hashes, Back/Forward/refresh, invalid route normalization', async () => {
    const ctx = await context('true', { width: 1440, height: 900 });
    try {
      const page = await ctx.newPage(), nav = new Navigation(page); await ready(page);
      await nav.link('settings'); assert.equal(await page.evaluate(() => window.wavesync.state.screen), 'home');
      await nav.link('privacy'); await nav.link('support');
      await page.goBack(); await page.waitForFunction(() => window.wavesync.ui.view === 'privacy');
      await page.goBack(); await page.waitForFunction(() => window.wavesync.ui.view === 'settings');
      await page.goForward(); await page.waitForFunction(() => window.wavesync.ui.view === 'privacy');
      await page.reload(); await page.waitForFunction(() => window.wavesync?.ui.view === 'privacy');
      await nav.hash('settings/privacy'); assert.ok(await page.locator('#settings-privacy').isVisible());
      await page.evaluate(() => { location.hash = 'unknown'; }); await page.waitForFunction(() => window.wavesync.ui.view === 'home' && location.hash === '#home');
      await page.evaluate(() => { location.hash = 'room'; }); await page.waitForFunction(() => window.wavesync.ui.view === 'home' && location.hash === '#home');
      await page.locator('#home-footer a[href="#privacy"]').click(); await page.waitForFunction(() => window.wavesync.ui.view === 'privacy');
      await audit(page, 'navigation');
      return { actualSidebarAndFooterClicks: true, productScreenPreserved: 'home', invalidRoomWithoutSession: 'home' };
    } finally { await ctx.close(); }
  });
  for (const size of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) for (const theme of ['light', 'dark']) await check(`Screenshot and DOM audit ${size.width}x${size.height} ${theme}`, async () => {
    const ctx = await context('true', size);
    try {
      const page = await ctx.newPage(), nav = new Navigation(page); await ready(page, 'settings');
      await page.locator('#theme-select').selectOption(theme);
      for (const route of ['home', 'settings', 'privacy', 'support']) {
        await nav.hash(route); await screenshot(page, `${route}-${size.width}x${size.height}-${theme}`); await audit(page, `${route}-${size.width}-${theme}`);
      }
      if (size.width < 960) { await nav.hash('home'); await page.locator('#nav-open').click(); await screenshot(page, `drawer-${size.width}x${size.height}-${theme}`); await page.keyboard.press('Escape'); }
      report.metrics.push({ label: `matrix-${size.width}-${theme}`, observation: await page.evaluate(() => ({ ...window.__qaMetrics, observedUntilMs: performance.now() })), interpretation: 'Observed session layout-shift sum excluding recent input; not a Lighthouse score or navigation-only Web Vital. Long tasks recorded only where supported.' });
    } finally { await ctx.close(); }
  });
  await check('Mobile drawer focus trap, Escape, backdrop, inert, scroll lock and focus restoration', async () => {
    const ctx = await context();
    try {
      const page = await ctx.newPage(), nav = new Navigation(page); await ready(page);
      await page.evaluate(() => {
        window.__qaFocusCalls = []; const nativeFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function(...args) {
          const before = { target: this.id || this.tagName, time: performance.now(), visibility: getComputedStyle(this).visibility, drawerOpen: window.wavesync.ui.drawerOpen, insideInert: !!this.closest('[inert]') };
          const result = nativeFocus.apply(this, args); window.__qaFocusCalls.push({ ...before, focused: document.activeElement.id || document.activeElement.tagName }); return result;
        };
      });
      await page.locator('#nav-open').click();
      assert.equal(await page.locator('#sidebar').getAttribute('role'), 'dialog'); assert.equal(await page.locator('#sidebar').getAttribute('aria-modal'), 'true');
      assert.equal(await page.evaluate(() => document.getElementById('main-content').inert && document.querySelector('.mobile-header').inert && document.body.style.overflow === 'hidden'), true);
      const initialFocus = await page.evaluate(() => ({ id: document.activeElement.id, tag: document.activeElement.tagName, insideDrawer: !!document.activeElement.closest('#sidebar'), closeVisibility: getComputedStyle(document.getElementById('nav-close')).visibility }));
      report.audits.push({ label: 'drawer-initial-focus', ...initialFocus });
      await settle(page);
      try { await page.waitForFunction(() => document.activeElement.id === 'nav-close', null, { timeout: 3000 }); }
      catch (error) { report.audits.push({ label: 'drawer-focus-calls', observations: await page.evaluate(() => window.__qaFocusCalls) }); throw error; }
      for (let i = 0; i < 15; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#sidebar')), true); }
      for (let i = 0; i < 15; i++) { await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#sidebar')), true); }
      await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-open');
      assert.equal(await page.evaluate(() => document.getElementById('main-content').inert || document.querySelector('.mobile-header').inert || document.body.style.overflow === 'hidden'), false);
      await page.locator('#nav-open').click(); await page.locator('#nav-backdrop').click({ position: { x: 380, y: 400 } });
      assert.equal(await page.locator('#nav-open').getAttribute('aria-expanded'), 'false'); assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-open');
      await nav.link('settings'); assert.equal(await page.locator('#settings-screen').isVisible(), true);
      await page.locator('#nav-open').click(); await page.locator('#nav-close').click(); assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-open');
      return { forwardAndReverseTabChecks: 30, dismissal: ['Escape', 'backdrop', 'close', 'route'] };
    } finally { await ctx.close(); }
  });
  await check('Mobile drawer Tab containment and dismissal independently of initial focus', async () => {
    const ctx = await context();
    try {
      const page = await ctx.newPage(); await ready(page); await page.locator('#nav-open').click(); await settle(page);
      for (let i = 0; i < 15; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#sidebar')), true); }
      for (let i = 0; i < 15; i++) { await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#sidebar')), true); }
      await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-open');
      await page.locator('#nav-open').click(); await page.locator('#nav-backdrop').click({ position: { x: 380, y: 400 } });
      assert.equal(await page.locator('#nav-open').getAttribute('aria-expanded'), 'false'); assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-open');
      assert.equal(await page.evaluate(() => document.getElementById('main-content').inert || document.querySelector('.mobile-header').inert || document.body.style.overflow === 'hidden'), false);
      return { tabAssertions: 30, EscapeAndBackdropRestore: true, initialFocus: 'separately asserted, not bypassed' };
    } finally { await ctx.close(); }
  });
  await check('Support UPI copy, optional amount, encoded intent, generated QR and safe handoff interception', async () => {
    const ctx = await context();
    try {
      const page = await ctx.newPage(); await ready(page, 'support');
      await page.locator('#support-copy').click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), (await page.locator('#support-upi-id').textContent()).trim());
      await page.locator('.donation-options > summary').click();
      const intents = [];
      for (const amount of ['50', '100', '250', '']) {
        await page.locator(`[data-donation-amount="${amount}"]`).click();
        const href = await page.locator('#upi-handoff').getAttribute('href'), url = new URL(href);
        assert.equal(url.protocol, 'upi:'); assert.equal(url.hostname, 'pay'); assert.equal(url.searchParams.get('cu'), 'INR');
        assert.equal(url.searchParams.get('pa'), (await page.locator('#support-upi-id').textContent()).trim()); assert.equal(url.searchParams.get('am'), amount || null);
        assert.equal(await page.locator('#support-qr').getAttribute('data-value'), href); assert.equal(await page.locator('#support-qr svg').count(), 1);
        assert.equal(await page.locator('[data-donation-amount][aria-pressed="true"]').count(), 1); intents.push({ amount: amount || 'any', protocol: url.protocol, currency: url.searchParams.get('cu'), qrEqualsIntent: true });
      }
      await page.evaluate(() => document.getElementById('upi-handoff').addEventListener('click', event => { event.preventDefault(); window.__qaHandoff = event.currentTarget.getAttribute('href'); }, { capture: true }));
      await page.locator('#upi-handoff').click(); assert.equal(await page.evaluate(() => window.__qaHandoff), await page.locator('#support-qr').getAttribute('data-value'));
      const scan = await page.evaluate(async () => {
        if (!('BarcodeDetector' in window)) return { status: 'not-available', reason: 'BarcodeDetector is absent; no scan claim.' };
        if (!(await BarcodeDetector.getSupportedFormats()).includes('qr_code')) return { status: 'not-available', reason: 'QR format unsupported.' };
        const svg = document.querySelector('#support-qr svg'), blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }), url = URL.createObjectURL(blob);
        try { const image = new Image(); image.src = url; await image.decode(); const codes = await new BarcodeDetector({ formats: ['qr_code'] }).detect(image); return { status: codes.length ? 'decoded' : 'not-decoded', values: codes.map(c => c.rawValue), expected: document.getElementById('support-qr').dataset.value }; }
        finally { URL.revokeObjectURL(url); }
      });
      if (scan.status === 'decoded') assert.ok(scan.values.includes(scan.expected));
      return { clipboardVerified: true, intents, handoff: 'click intercepted before navigation; payment app not launched', scan };
    } finally { await ctx.close(); }
  });
  await check('Theme/system/reduced motion persistence and local remembered/default volume', async () => {
    const ctx = await context('true', { width: 390, height: 844 }, { 'wavesync.settings': '{"defaultVolume":0.35,"rememberVolume":false}', 'wavesync.volume': '0.12' });
    try {
      const page = await ctx.newPage(); await ready(page, 'settings');
      assert.equal(await page.evaluate(() => window.wavesync.audio.volume), 0.35);
      await range(page, '#default-volume', 0.42); assert.equal(await page.evaluate(() => window.wavesync.audio.volume), 0.42);
      assert.equal(await page.locator('#default-volume-value').textContent(), '42%');
      await page.locator('#remember-volume').check();
      await range(page, '#volume-control', 0.27); assert.equal(await page.evaluate(() => window.wavesync.audio.volume), 0.27);
      await page.locator('#theme-select').selectOption('dark'); await page.locator('#reduced-motion').check();
      await page.reload(); await page.waitForFunction(() => !!window.wavesync);
      assert.equal(await page.evaluate(() => window.wavesync.audio.volume), 0.27); assert.equal(await page.locator('#theme-select').inputValue(), 'dark');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.reducedMotion), 'true');
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).transitionDuration), '0s');
      await page.locator('#theme-select').selectOption('system'); await page.emulateMedia({ colorScheme: 'dark' }); await settle(page);
      const dark = await page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, meta: document.querySelector('meta[name="theme-color"]').content }));
      await page.emulateMedia({ colorScheme: 'light' }); await settle(page);
      const light = await page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, meta: document.querySelector('meta[name="theme-color"]').content }));
      assert.notEqual(dark.background, light.background); assert.notEqual(dark.meta, light.meta);
      await page.locator('#reduced-motion').uncheck(); await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).transitionDuration), '0s');
      await page.locator('#remember-volume').uncheck(); assert.equal(await page.evaluate(() => localStorage.getItem('wavesync.volume')), null);
      await page.reload(); await page.waitForFunction(() => !!window.wavesync); assert.equal(await page.evaluate(() => window.wavesync.audio.volume), 0.42);
      assert.equal(await page.locator('#channel-enabled').isChecked(), false); assert.equal(await page.evaluate(() => window.wavesync.audio.channelMode), 'off');
      return { defaultVolume: 0.42, rememberedVolume: 0.27, systemColors: { dark, light }, reducedMotionStoredAndMedia: true, channelDisabledDefault: true };
    } finally { await ctx.close(); }
  });
  await check('Confirmation modal contains focus and backdrop cancels with opener restored', async () => {
    const ctx = await context('true', { width: 390, height: 844 });
    try {
      const page = await ctx.newPage(); await ready(page, 'settings/privacy');
      await page.locator('[data-action="resetPreferences"]').click();
      assert.equal(await page.locator('#confirm-dialog').evaluate(e => e.open), true);
      const modalFocus = [];
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        modalFocus.push(await page.evaluate(() => ({ tag: document.activeElement.tagName, id: document.activeElement.id, text: document.activeElement.textContent?.slice(0, 70), insideDialog: !!document.activeElement.closest('#confirm-dialog') })));
      }
      report.audits.push({ label: 'confirmation-tab-focus', observations: modalFocus });
      await screenshot(page, 'confirmation-390x844');
      assert.ok(modalFocus.every(f => f.insideDialog), JSON.stringify(modalFocus));
      await page.mouse.click(5, 5);
      await page.waitForFunction(() => !document.getElementById('confirm-dialog').open, null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'resetPreferences');
      return { tabAssertions: 6, backdropCancelled: true, focusRestored: true };
    } finally { await ctx.close(); }
  });
  await check('Confirmation backdrop independently cancels and restores opener', async () => {
    const ctx = await context();
    try {
      const page = await ctx.newPage(); await ready(page, 'settings/privacy'); await page.locator('[data-action="resetPreferences"]').click();
      await page.mouse.click(5, 5);
      await page.waitForFunction(() => !document.getElementById('confirm-dialog').open, null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'resetPreferences');
      return { backdropCancelled: true, openerRestored: true };
    } finally { await ctx.close(); }
  });
  await check('Skip link on Settings and Privacy focuses main without changing hash or route', async () => {
    const ctx = await context();
    try {
      const page = await ctx.newPage(), nav = new Navigation(page); await ready(page, 'settings');
      for (const route of ['settings', 'privacy']) {
        await nav.hash(route); const hash = new URL(page.url()).hash;
        await page.locator('.skip-link').focus(); await page.locator('.skip-link').click();
        assert.equal(await page.evaluate(() => window.wavesync.ui.view), route); assert.equal(new URL(page.url()).hash, hash);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'main-content');
      }
      return { tested: ['settings', 'privacy'], hashAndRoutePreserved: true, mainFocused: true };
    } finally { await ctx.close(); }
  });
  await check('Notification defaults, toggles, reload persistence and actual event suppression', async () => {
    const ctx = await context();
    try {
      const page = await ctx.newPage(); await ready(page, 'settings');
      const kinds = ['room', 'playback', 'transfer', 'reconnect'];
      for (const kind of kinds) assert.equal(await page.locator(`#notify-${kind}`).isChecked(), true, `${kind}: default checkbox must match enabled preference`);
      for (const kind of kinds) await page.locator(`#notify-${kind}`).uncheck();
      assert.deepEqual(await page.evaluate(() => window.wavesync.settings.preferences.notifications), { room: false, playback: false, transfer: false, reconnect: false });
      await page.reload(); await page.waitForFunction(() => !!window.wavesync); await settle(page);
      for (const kind of kinds) assert.equal(await page.locator(`#notify-${kind}`).isChecked(), false);
      const suppressed = await page.evaluate(() => {
        const app = window.wavesync, original = app.ui.notify; let emitted = [];
        app.ui.notify = (message, error) => emitted.push({ message, error });
        try { for (const kind of ['room', 'playback', 'transfer', 'reconnect']) app.settings.event(kind, `QA ${kind}`); app.settings.event('transfer', 'QA error', true); }
        finally { app.ui.notify = original; }
        return emitted;
      });
      assert.deepEqual(suppressed, [{ message: 'QA error', error: true }]);
      await page.locator('#notify-playback').check();
      const resumed = await page.evaluate(() => {
        const app = window.wavesync, original = app.ui.notify, emitted = [];
        app.ui.notify = (message, error) => emitted.push({ message, error });
        try { app.settings.event('playback', 'QA playback'); } finally { app.ui.notify = original; }
        return emitted;
      });
      assert.deepEqual(resumed, [{ message: 'QA playback', error: false }]);
      await page.reload(); await page.waitForFunction(() => !!window.wavesync); assert.equal(await page.locator('#notify-playback').isChecked(), true);
      return { defaultsMatch: true, disabledAcrossReload: kinds, suppressedNonErrorEvents: 4, errorsStillVisible: true, reenabledPlaybackEmits: true };
    } finally { await ctx.close(); }
  });
  await check('Real OfflineAudioContext renders production channel graph: stereo Left/Right/Off and mono', async () => {
    const ctx = await context();
    try {
      const page = await ctx.newPage(); await ready(page);
      const samples = await page.evaluate(async () => {
        const { AudioEngine } = await import('./src/audio-engine.js'), results = [];
        for (const channels of [2, 1]) for (const mode of ['off', 'left', 'right']) {
          const ctx = new OfflineAudioContext(2, 4096, 48000), engine = new AudioEngine();
          engine.ctx = ctx; engine.gain = ctx.createGain(); engine._buildChannelGraph();
          const buffer = ctx.createBuffer(channels, 4096, 48000);
          buffer.getChannelData(0).fill(0.125); if (channels === 2) buffer.getChannelData(1).fill(-0.25);
          engine.setBuffer(buffer); engine.setChannelMode(mode);
          const source = ctx.createBufferSource(); source.buffer = buffer; engine._connectSource(source); source.start();
          const rendered = await ctx.startRendering(), sourceExpected = channels === 1 ? [0.125, 0.125] : mode === 'left' ? [0.125, 0.125] : mode === 'right' ? [-0.25, -0.25] : [0.125, -0.25];
          // Production applies local RMS normalization before channel selection.
          const expected = sourceExpected.map(value => value * engine.normGain * engine.volume);
          const errors = [0, 1].map(c => Math.max(...rendered.getChannelData(c).slice(2048).map(v => Math.abs(v - expected[c]))));
          results.push({ channels, mode, effective: engine._effectiveChannelMode, expected, observed: [rendered.getChannelData(0)[3000], rendered.getChannelData(1)[3000]], maxErrors: errors });
        }
        return results;
      });
      for (const sample of samples) assert.ok(sample.maxErrors.every(e => e < 1e-5), JSON.stringify(sample));
      return samples;
    } finally { await ctx.close(); }
  });
  await check('Real empty-room themed artwork visibility and screenshots', async () => {
    const ctx = await context();
    try {
      const page = await ctx.newPage(), nav = new Navigation(page); await ready(page);
      await page.locator('#create-room').click(); await page.waitForFunction(() => !!window.wavesync.epoch);
      const observations = [];
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        for (const theme of ['light', 'dark']) {
          await nav.hash('settings'); await page.locator('#theme-select').selectOption(theme); await nav.hash('room');
          const art = await page.locator('#track-art img').evaluateAll(images => images.map(image => ({ src: image.getAttribute('src'), visible: !!image.getClientRects().length, loaded: image.complete && image.naturalWidth > 0 })));
          assert.equal(art.filter(image => image.visible).length, 1); assert.ok(art.every(image => image.loaded));
          assert.ok(art.find(image => image.visible).src.endsWith(`wavesync-mark-${theme}.svg`));
          observations.push({ width, theme, art }); await audit(page, `room-artwork-${width}-${theme}`);
          await screenshot(page, `room-empty-${width}x${width === 390 ? 844 : 900}-${theme}`);
        }
      }
      await page.evaluate(() => window.wavesync.leave());
      return { realLocalRoom: true, observations, playback: 'Not exercised here; preserved real playback evidence is separate.' };
    } finally { await ctx.close(); }
  });
  await check('Guest autoSync Off, manual alignment, authoritative pause, next track and host loss', async () => {
    const hostCtx = await context('true', { width: 1440, height: 900 }), guestCtx = await context();
    try {
      const host = await hostCtx.newPage(), guest = await guestCtx.newPage(), nav = new Navigation(guest);
      await ready(host); await ready(guest, 'settings'); await guest.locator('#auto-sync').uncheck(); await nav.hash('home');
      await host.locator('#display-name').fill('QA host'); await host.locator('#create-room').click();
      await host.waitForFunction(() => window.wavesync.epoch && window.wavesync.signal.clock.synced);
      const code = await host.evaluate(() => window.wavesync.state.code);
      await guest.locator('#display-name').fill('QA guest'); await guest.locator('#join-code').fill(code); await guest.locator('#join-room').click();
      await guest.waitForFunction(() => window.wavesync.epoch && window.wavesync.signal.clock.synced);
      await host.locator('#audio-files').setInputFiles([{ name: 'Sync A.wav', mimeType: 'audio/wav', buffer: wav(120, false) }, { name: 'Sync B.wav', mimeType: 'audio/wav', buffer: wav(120, false) }]);
      await host.waitForFunction(() => window.wavesync.activeId && !window.wavesync.state.loading);
      await guest.waitForFunction(() => window.wavesync.cache.get(window.wavesync.activeId), null, { timeout: 45000 });
      assert.equal(await guest.evaluate(() => window.wavesync.sync.automatic), false);
      await host.waitForFunction(() => window.wavesync.signal.clock.synced, null, { timeout: 20000 });
      await host.locator('#play-toggle').click(); await guest.waitForFunction(() => window.wavesync.sync.timeline?.playing === true);
      assert.equal(await guest.evaluate(() => window.wavesync.audio.playing), false);
      await nav.hash('settings'); await guest.locator('#settings-resync').click(); await nav.hash('room');
      await guest.waitForFunction(() => window.wavesync.audio.playing); assert.equal(await guest.evaluate(() => window.wavesync.sync.scheduler.running), false);
      await host.locator('#play-toggle').click(); await guest.waitForFunction(() => !window.wavesync.audio.playing);
      const firstTrack = await host.evaluate(() => window.wavesync.activeId);
      await host.locator('#next-track').click(); await host.waitForFunction(id => window.wavesync.activeId !== id, firstTrack);
      await guest.waitForFunction(id => window.wavesync.activeId !== id && window.wavesync.cache.get(window.wavesync.activeId), firstTrack);
      await host.waitForFunction(() => window.wavesync.signal.clock.synced, null, { timeout: 20000 });
      await host.locator('#play-toggle').click(); await guest.waitForFunction(() => window.wavesync.sync.timeline?.playing === true);
      assert.equal(await guest.evaluate(() => window.wavesync.audio.playing), false);
      await nav.hash('settings'); await guest.locator('#settings-resync').click(); await nav.hash('room'); await guest.waitForFunction(() => window.wavesync.audio.playing);
      await host.evaluate(() => window.wavesync.leave()); await guest.waitForFunction(() => !window.wavesync.hostAvailable);
      await guest.waitForFunction(() => window.wavesync.signal.clock.quality().samples >= 6); assert.equal(await guest.evaluate(() => window.wavesync.audio.playing), false);
      return { automatic: false, hostPlayDoesNotAutostart: true, manualStartsPlayback: true, pauseAndNextAndHostLoss: true };
    } catch (error) {
      report.audits.push({ label: 'autosync-failure', observations: await Promise.all([hostCtx, guestCtx].map(async ctx => {
        const page = ctx.pages()[0]; return page?.evaluate(() => { const a = window.wavesync; return a && { role: a.state.role, playing: a.audio.playing, position: a.audio.position(), activeId: a.activeId, status: a.state.status, homeError: a.state.homeError, connection: a.state.connection, code: a.state.code, registered: a.signal?.registered, hostAvailable: a.hostAvailable, automatic: a.sync?.automatic, timeline: a.sync?.timeline }; }).catch(() => null);
      })) });
      throw error;
    } finally { await hostCtx.close(); await guestCtx.close(); }
  });
  await check('Local WebSocket/WebRTC stereo transfer, independent playback channels and active-room reset/clear', async () => {
    const hostCtx = await context('true', { width: 1440, height: 900 }), guestCtx = await context();
    try {
      const host = await hostCtx.newPage(), guest = await guestCtx.newPage(), hostNav = new Navigation(host), guestNav = new Navigation(guest);
      await ready(host); await ready(guest);
      await host.locator('#display-name').fill('QA host'); await host.locator('#create-room').click();
      await host.waitForFunction(() => window.wavesync.epoch && window.wavesync.signal.clock.synced, null, { timeout: 25000 });
      const code = await host.evaluate(() => window.wavesync.state.code);
      const roomHash = new URL(host.url()).hash;
      await host.locator('.skip-link').focus(); await host.locator('.skip-link').click();
      assert.equal(await host.evaluate(() => document.activeElement.id), 'main-content');
      assert.equal(await host.evaluate(() => window.wavesync.ui.view), 'room'); assert.equal(new URL(host.url()).hash, roomHash);
      await hostNav.hash('home');
      await host.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
      assert.equal(await host.locator('#create-room').isDisabled(), true); assert.equal(await host.locator('#join-room').isDisabled(), true);
      await hostNav.hash('room');
      await guest.locator('#display-name').fill('QA guest'); await guest.locator('#join-code').fill(code); await guest.locator('#join-room').click();
      await guest.waitForFunction(() => window.wavesync.epoch && window.wavesync.signal.clock.synced, null, { timeout: 25000 });
      await guest.evaluate(() => window.wavesync.audio.ctx.suspend()); await guest.waitForFunction(() => !window.wavesync.state.audioEnabled);
      await screenshot(guest, 'permission-390x844'); await guest.locator('#enable-audio').click(); await guest.waitForFunction(() => window.wavesync.audio.ctx.state === 'running');
      await host.locator('#audio-files').setInputFiles([{ name: 'Stereo QA.wav', mimeType: 'audio/wav', buffer: wav(60, true) }, { name: 'Mono QA.wav', mimeType: 'audio/wav', buffer: wav(60, false) }]);
      await host.waitForFunction(() => window.wavesync.activeId && !window.wavesync.state.loading);
      try { await guest.waitForFunction(() => window.wavesync.cache.get(window.wavesync.activeId), null, { timeout: 45000 }); }
      catch (error) {
        const transport = await Promise.all([host, guest].map(page => page.evaluate(() => {
          const a = window.wavesync;
          return { role: a.state.role, status: a.state.status, activeId: a.activeId, fileMeta: a.fileMeta && { trackId: a.fileMeta.trackId, size: a.fileMeta.size }, transfer: a.state.transfer, cacheReady: !!a.cache.get(a.activeId), peers: [...a.peers.peers.values()].map(p => ({ dc: p.dc?.readyState, connection: p.pc?.connectionState, ice: p.pc?.iceConnectionState })) };
        })));
        report.audits.push({ label: 'transfer-timeout', transport }); await screenshot(host, 'transfer-timeout-host'); await screenshot(guest, 'transfer-timeout-guest'); throw error;
      }
      await host.locator('#play-toggle').click(); await guest.waitForFunction(() => window.wavesync.audio.playing, null, { timeout: 15000 });
      for (const [page, nav] of [[host, hostNav], [guest, guestNav]]) {
        assert.equal(await page.locator('#channel-control').isVisible(), false);
        await nav.hash('settings'); await page.locator('#channel-enabled').check(); await nav.hash('room');
      }
      const channelObservations = [];
      for (const [hostMode, guestMode] of [['left', 'right'], ['right', 'left'], ['off', 'off']]) {
        for (const [page, mode] of [[host, hostMode], [guest, guestMode]]) {
          await page.evaluate(() => { const a = window.wavesync.audio; window.__qaBeforeChannel = { source: a.source, position: a.position(), time: a.ctx.currentTime, track: window.wavesync.activeId }; });
          await page.locator('#player-channel').selectOption(mode);
          const observed = await page.evaluate(() => { const a = window.wavesync.audio, b = window.__qaBeforeChannel; return { mode: a.channelMode, sourceUnchanged: a.source === b.source, trackUnchanged: window.wavesync.activeId === b.track, playing: a.playing, positionDelta: a.position() - b.position, contextDelta: a.ctx.currentTime - b.time }; });
          assert.equal(observed.mode, mode); assert.equal(observed.sourceUnchanged, true); assert.equal(observed.trackUnchanged, true); assert.equal(observed.playing, true);
          assert.ok(Math.abs(observed.positionDelta - observed.contextDelta) < 0.1, JSON.stringify(observed)); channelObservations.push(observed);
        }
        assert.equal(await host.evaluate(() => window.wavesync.audio.channelMode), hostMode); assert.equal(await guest.evaluate(() => window.wavesync.audio.channelMode), guestMode);
      }
      await screenshot(host, 'room-host-1440x900'); await screenshot(guest, 'room-guest-390x844'); await audit(host, 'room-host'); await audit(guest, 'room-guest');
      assert.equal(await guest.locator('[data-host-only]:visible').count(), 0);
      await guestNav.hash('settings'); await guest.locator('#notify-playback').uncheck(); await guestNav.hash('room');
      await guest.evaluate(() => { const ui = window.wavesync.ui, original = ui.notify.bind(ui); window.__qaActualNotices = []; ui.notify = (message, error) => { window.__qaActualNotices.push({ message, error }); return original(message, error); }; });
      const roomIdentity = await host.evaluate(() => ({ code: window.wavesync.state.code, epoch: window.wavesync.epoch, track: window.wavesync.activeId }));
      await host.evaluate(() => { localStorage.setItem('qa.unrelated', 'keep'); localStorage.setItem('wavesync.name', 'QA host'); localStorage.setItem('wavesync.testHistory', 'retain-on-reset'); });
      await hostNav.hash('settings/privacy');
      await host.locator('[data-action="resetPreferences"]').click(); await host.locator('#confirm-dialog button[value="cancel"]').click();
      assert.equal(await host.evaluate(() => localStorage.getItem('wavesync.testHistory')), 'retain-on-reset'); assert.equal(await host.locator('#channel-enabled').isChecked(), true);
      assert.equal(await host.evaluate(() => document.activeElement.dataset.action), 'resetPreferences');
      await host.locator('[data-action="resetPreferences"]').click(); await host.locator('#confirm-accept').click(); await host.waitForFunction(() => !window.wavesync.settings.preferences.channelEnabled);
      assert.equal(await host.evaluate(() => localStorage.getItem('wavesync.name')), 'QA host'); assert.equal(await host.evaluate(() => localStorage.getItem('wavesync.testHistory')), 'retain-on-reset');
      await host.locator('[data-action="clearData"]').click(); await host.keyboard.press('Escape'); assert.equal(await host.evaluate(() => localStorage.getItem('wavesync.testHistory')), 'retain-on-reset');
      await host.locator('[data-action="clearData"]').click(); await host.locator('#confirm-accept').click(); await host.waitForFunction(() => localStorage.getItem('wavesync.testHistory') === null);
      assert.equal(await host.evaluate(() => localStorage.getItem('qa.unrelated')), 'keep');
      assert.deepEqual(await host.evaluate(() => ({ code: window.wavesync.state.code, epoch: window.wavesync.epoch, track: window.wavesync.activeId })), roomIdentity);
      assert.equal(await host.evaluate(() => window.wavesync.state.screen), 'room'); assert.equal(await host.evaluate(() => window.wavesync.audio.playing), true);
      assert.equal(await guest.evaluate(() => window.wavesync.audio.channelMode), 'off');
      await hostNav.hash('room'); await host.locator('#play-toggle').click(); await guest.waitForFunction(() => !window.wavesync.audio.playing);
      assert.equal(await guest.evaluate(() => window.__qaActualNotices.some(n => n.message === 'Host paused playback.')), false);
      await guestNav.hash('settings'); await guest.locator('#notify-playback').check(); await guestNav.hash('room');
      await guestNav.hash('settings'); await guest.locator('#auto-sync').uncheck(); await guestNav.hash('room');
      assert.equal(await guest.evaluate(() => window.wavesync.sync.automatic), false);
      assert.equal(await guest.evaluate(() => window.wavesync.sync.scheduler.running), false);
      await host.locator('#next-track').click(); await guest.waitForFunction(() => window.wavesync.activeId === window.wavesync.fileMeta?.trackId && window.wavesync.cache.get(window.wavesync.activeId));
      await guest.locator('#player-channel').selectOption('left'); assert.match(await guest.locator('#channel-help').textContent(), /Mono source/);
      await host.locator('#play-toggle').click(); await guest.waitForFunction(() => window.wavesync.sync.timeline?.playing === true);
      assert.equal(await guest.evaluate(() => window.wavesync.audio.playing), false);
      await guestNav.hash('settings'); await guest.locator('#settings-resync').click(); await guestNav.hash('room');
      await guest.waitForFunction(() => window.wavesync.audio.playing);
      assert.equal(await guest.evaluate(() => window.wavesync.sync.scheduler.running), false);
      assert.equal(await guest.evaluate(() => window.__qaActualNotices.some(n => n.message === 'Host started playback.')), true);
      assert.equal(await guest.evaluate(() => window.wavesync.audio._effectiveChannelMode), 'off');
      await host.locator('#play-toggle').click(); await guest.waitForFunction(() => !window.wavesync.audio.playing);
      assert.equal(await guest.evaluate(() => window.wavesync.sync.automatic), false);
      await host.waitForFunction(() => window.wavesync.signal.clock.synced, null, { timeout: 20000 });
      await host.locator('#play-toggle').click(); await guest.waitForFunction(() => window.wavesync.sync.timeline?.playing === true);
      await guestNav.hash('settings'); await guest.locator('#settings-resync').click(); await guestNav.hash('room'); await guest.waitForFunction(() => window.wavesync.audio.playing);
      await guest.evaluate(() => window.wavesync.signal.reconnect()); await guest.waitForFunction(() => window.wavesync.signal.registered && [...window.wavesync.peers.peers.values()].some(p => p.dc?.readyState === 'open'), null, { timeout: 25000 });
      await guestNav.hash('settings'); await guest.locator('#settings-resync').click(); await guestNav.hash('room'); await guest.waitForFunction(() => window.wavesync.audio.playing);
      await host.evaluate(() => window.wavesync.leave()); await guest.waitForFunction(() => !window.wavesync.hostAvailable);
      await guest.waitForFunction(() => window.wavesync.signal.clock.quality().samples >= 6, null, { timeout: 10000 }); assert.equal(await guest.evaluate(() => window.wavesync.audio.playing), false);
      await screenshot(guest, 'room-host-loss-390x844');
      await guest.evaluate(() => window.wavesync.leave()); await guest.locator('#join-code').fill('AAAAAA'); await guest.locator('#join-room').click();
      await guest.waitForFunction(() => window.wavesync.state.screen === 'home' && !!window.wavesync.state.homeError); await screenshot(guest, 'error-390x844'); await audit(guest, 'error');
      return { transport: 'real local WebSocket + WebRTC DataChannel, no STUN', channelObservations, resetCancelAndAccept: true, clearEscapeAndAccept: true, activeRoomPreserved: true, unrelatedKeyPreserved: true, monoEffectiveMode: 'off', pauseReconnectHostLoss: true, skipRoomPreserved: true, activeHomeOnlineControlsDisabled: true, autoSyncOffManualNextPauseHostLoss: true, actualPlaybackNotificationSuppression: true };
    } finally { await hostCtx.close(); await guestCtx.close(); }
  });
  await check('No page errors or broken local asset requests across all exercised journeys', async () => { assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.brokenAssets, []); return { pageErrors: 0, brokenAssets: 0 }; });
  report.status = report.cases.some(c => c.status === 'fail') ? 'fail' : 'pass';
  report.sourceHashesEnd = {};
  for (const file of Object.keys(report.sourceHashes)) report.sourceHashesEnd[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
  report.sourceUnchangedDuringRun = JSON.stringify(report.sourceHashes) === JSON.stringify(report.sourceHashesEnd);
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ status: report.status, pass: report.cases.filter(c => c.status === 'pass').length, fail: report.cases.filter(c => c.status === 'fail').map(c => c.name), report: resolve(evidence, `${runLabel}.json`) }, null, 2));
  if (report.status === 'fail') process.exitCode = 1;
} catch (error) { report.status = 'error'; report.fatalError = error.stack; await persist(); throw error; }
finally { await browser?.close(); await Promise.all([web, signal].map(s => new Promise(r => s.close(r)))); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { UI } from '../src/ui.js';
import { mount } from '../official/bootstrap.js';

function globals(values) {
  const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } };
}

function confirmation() {
  const dialog = new EventTarget();
  Object.assign(dialog, {
    open: false, returnValue: '',
    showModal() { this.open = true; },
    close(value) { this.returnValue = value; this.open = false; this.dispatchEvent(new Event('close')); },
    animate() { return { finished: new Promise(() => {}), cancel() {} }; }
  });
  const ui = Object.create(UI.prototype);
  Object.assign(ui, { root: { getElementById: id => id === 'confirm-dialog' ? dialog : null }, listeners: [], el: {}, handlers: {}, _text() {}, _closeDrawer() {} });
  const restore = globals({ document: { activeElement: { focus() {} }, documentElement: { dataset: {} } }, window: { matchMedia: () => ({ matches: false }) } });
  return { ui, dialog, restore };
}

test('destroy cancels a confirmed dialog while its exit is still pending', async () => {
  const { ui, dialog, restore } = confirmation();
  try {
    const result = ui.confirm('Clear local data?', 'Must not run after teardown.');
    ui._dismissConfirmation('confirm');
    assert.equal(dialog.open, true);
    ui.destroy();
    assert.equal(await result, false);
    assert.equal(dialog.open, false);
  } finally { ui.destroy(); restore(); }
});

test('reduced-motion completion preserves a deliberate confirmation without teardown', async () => {
  const { ui, dialog, restore } = confirmation();
  try {
    const result = ui.confirm('Reset?', 'Intent remains valid.');
    ui._dismissConfirmation('confirm');
    ui._stopMotion();
    assert.equal(await result, true);
    assert.equal(dialog.open, false);
  } finally { ui.destroy(); restore(); }
});

test('official feature response cannot mount or navigate after app destruction', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, hidden: true, addEventListener() {}, removeEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {} });
    return elements.get(id);
  };
  const entries = [element('support-entry')];
  let resolveFeatures;
  const restore = globals({
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => element(Symbol()), visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) },
    navigator: { onLine: true },
    location: { href: 'https://independent.example/#support', hash: '#support', search: '', hostname: 'independent.example', protocol: 'https:' },
    history: { replaceState() {} },
    fetch: async url => String(url).includes('features.json') ? new Promise(resolve => { resolveFeatures = resolve; }) : { ok: false }
  });
  const ui = {
    root: { getElementById: element, querySelectorAll: () => entries }, routes: new Set(['home']), view: 'home',
    navigate(route) { this.view = route; location.hash = '#' + route; },
    registerRoute(route) { this.routes.add(route); return true; }, unregisterRoute(route) { return this.routes.delete(route); },
    bind() {}, render() { location.hash = '#home'; }, renderSettings() {}, renderQueue() {}, renderDevices() {}, reset() {}, notify() {}, renderQR() {}, destroy() { this.destroyed = true; }
  };
  const audio = { volume: 1, setVolume(value) { this.volume = value; }, setChannelMode() {}, addLifecycleListener() {}, clear() {}, async dispose() {} };
  let app;
  try {
    const pending = mount({ ui, audio });
    app = window.wavesync;
    assert.ok(app);
    await app.destroy();
    resolveFeatures({ ok: true, json: async () => ({ supportCreator: true }) });
    await pending;
    assert.equal(ui.destroyed, true);
    assert.equal(ui.routes.has('support'), false);
    assert.equal(entries[0].hidden, true);
    assert.equal(app.extensions?.some(extension => extension.mounted) || false, false);
    assert.equal(ui.view, 'home');
  } finally { app?.extensions?.forEach(extension => extension.destroy()); restore(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFeatures } from '../official/features.js';

test('loads an explicitly enabled creator-support feature', async () => {
  const calls = [];
  const result = await loadFeatures(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ supportCreator: true }) };
  });
  assert.deepEqual(result, { supportCreator: true });
  assert.equal(calls[0].url, './config/features.json');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('accepts false and rejects non-boolean feature values', async () => {
  assert.deepEqual(await loadFeatures(async () => ({ ok: true, json: async () => ({ supportCreator: false }) })), { supportCreator: false });
  assert.deepEqual(await loadFeatures(async () => ({ ok: true, json: async () => ({ supportCreator: 1 }) })), { supportCreator: false });
});

test('fails closed for missing feature, invalid JSON, and failed fetches', async () => {
  assert.deepEqual(await loadFeatures(async () => ({ ok: true, json: async () => ({}) })), { supportCreator: false });
  assert.deepEqual(await loadFeatures(async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid'); } })), { supportCreator: false });
  assert.deepEqual(await loadFeatures(async () => ({ ok: false, json: async () => ({ supportCreator: true }) })), { supportCreator: false });
  assert.deepEqual(await loadFeatures(async () => { throw new TypeError('offline'); }), { supportCreator: false });
});

test('aborts a fetch that exceeds the bounded timeout', async () => {
  let aborted = false;
  const started = Date.now();
  const result = await loadFeatures((_url, { signal }) => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }), { timeoutMs: 25 });
  assert.deepEqual(result, { supportCreator: false });
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1000);
});

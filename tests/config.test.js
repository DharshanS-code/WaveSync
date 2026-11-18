import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SIGNAL_URL, resolveSignalUrl } from '../src/config.js';

test('source preview never inherits a public endpoint even with old URL overrides', () => {
  assert.equal(DEFAULT_SIGNAL_URL, '');
  assert.equal(resolveSignalUrl({hostname:'dharshans-code.github.io',protocol:'https:',search:'?signal=wss://old.example/api'}),DEFAULT_SIGNAL_URL);
});
test('public resolution never accesses old saved signaling preferences', () => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('Storage unavailable');}});
  try { assert.equal(resolveSignalUrl({hostname:'example.test',protocol:'https:',search:''}),DEFAULT_SIGNAL_URL); }
  finally { if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete globalThis.localStorage; }
});
test('loopback testing retains explicit endpoint override and safe fallback', () => {
  assert.equal(resolveSignalUrl({hostname:'127.0.0.1',protocol:'http:',search:'?signal=ws://127.0.0.1:9999/api/room'}),'ws://127.0.0.1:9999/api/room');
  assert.equal(resolveSignalUrl({hostname:'localhost',protocol:'https:',search:'?signal=ws://invalid.test'}),'wss://localhost:8787/api/room');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MotionController,
  animateEntry,
  animateExit,
  cancelMotion,
  reducedMotion
} from '../src/motion.js';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function restoreGlobals() {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete globalThis.window;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}

function installEnvironment({ stored = false, media = false, standalone = false, iosStandalone = false } = {}) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { dataset: stored ? { reducedMotion: 'true' } : {} } }
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: query => ({
        matches: query === '(display-mode: standalone)' ? standalone : media,
        media: query
      })
    }
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { standalone: iosStandalone }
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; });
  return { promise, resolve, reject };
}

function fakeElement() {
  const calls = [];
  return {
    calls,
    animate(keyframes, options) {
      const completion = deferred();
      const animation = {
        finished: completion.promise,
        cancelCount: 0,
        cancel() {
          this.cancelCount += 1;
          completion.reject(new Error('cancelled'));
        },
        resolve: completion.resolve
      };
      calls.push({ keyframes, options, animation });
      return animation;
    }
  };
}

test.afterEach(restoreGlobals);

test('reducedMotion detects stored and operating-system preferences', () => {
  installEnvironment();
  assert.equal(reducedMotion(), false);

  installEnvironment({ stored: true });
  assert.equal(reducedMotion(), true);

  installEnvironment({ media: true });
  assert.equal(reducedMotion(), true);
});

test('reducedMotion is safe without browser globals', () => {
  delete globalThis.document;
  delete globalThis.window;
  assert.equal(reducedMotion(), false);
});

test('entry animation coalesces while active and can replay after completion', async () => {
  installEnvironment();
  const element = fakeElement();

  const first = animateEntry(element, 'page');
  const repeated = animateEntry(element, 'page');

  assert.ok(first instanceof MotionController);
  assert.strictEqual(repeated, first);
  assert.equal(element.calls.length, 1);
  const [{ keyframes, options, animation }] = element.calls;
  assert.deepEqual([...new Set(keyframes.flatMap(frame => Object.keys(frame)))].sort(), ['opacity', 'transform']);
  assert.equal(options.duration, 200);
  assert.equal(options.delay ?? 0, 0);

  animation.resolve();
  await first.finished;
  assert.equal(animation.cancelCount, 1);

  const afterFinish = animateEntry(element, 'page');
  assert.equal(element.calls.length, 2);
  element.calls[1].animation.resolve();
  await afterFinish.finished;
});

test('drawer and backdrop entries use their directional and fade keyframes', async () => {
  installEnvironment();
  const drawer = fakeElement();
  const drawerController = animateEntry(drawer, 'drawer');
  assert.deepEqual(drawer.calls[0].keyframes, [
    { opacity: 0, transform: 'translateX(-24px)' },
    { opacity: 1, transform: 'translateX(0)' }
  ]);
  drawer.calls[0].animation.resolve();
  await drawerController.finished;

  const backdrop = fakeElement();
  const backdropController = animateEntry(backdrop, 'backdrop');
  assert.deepEqual(backdrop.calls[0].keyframes, [
    { opacity: 0, transform: 'translateZ(0)' },
    { opacity: 1, transform: 'translateZ(0)' }
  ]);
  backdrop.calls[0].animation.resolve();
  await backdropController.finished;
});

test('launch entry runs only once in browser or iOS standalone display mode', async () => {
  installEnvironment();
  const browserElement = fakeElement();
  await animateEntry(browserElement, 'launch').finished;
  assert.equal(browserElement.calls.length, 0);

  installEnvironment({ iosStandalone: true });
  const standaloneElement = fakeElement();
  const controller = animateEntry(standaloneElement, 'launch');
  assert.equal(standaloneElement.calls.length, 1);
  standaloneElement.calls[0].animation.resolve();
  await controller.finished;

  const laterSurface = fakeElement();
  await animateEntry(laterSurface, 'launch').finished;
  assert.equal(laterSurface.calls.length, 0);
});

test('entry interrupts an active exit instead of coalescing with it', async () => {
  installEnvironment();
  const element = fakeElement();
  let exited = 0;
  const exiting = animateExit(element, 'drawer', () => { exited += 1; });
  const exitAnimation = element.calls[0].animation;
  const entering = animateEntry(element, 'drawer');

  assert.equal(exitAnimation.cancelCount, 1);
  assert.equal(element.calls.length, 2);
  await exiting.finished;
  assert.equal(exited, 0);
  element.calls[1].animation.resolve();
  await entering.finished;
});

test('a newer exit cancels the old animation and ignores its stale completion', async () => {
  installEnvironment();
  const element = fakeElement();
  let oldDone = 0;
  let newDone = 0;

  const oldController = animateExit(element, 'dialog', () => { oldDone += 1; });
  const oldAnimation = element.calls[0].animation;
  const newController = animateExit(element, 'dialog', () => { newDone += 1; });
  const newAnimation = element.calls[1].animation;

  assert.equal(oldAnimation.cancelCount, 1);
  await oldController.finished;
  assert.equal(oldDone, 0);

  oldAnimation.resolve();
  await Promise.resolve();
  assert.equal(oldDone, 0);

  newAnimation.resolve();
  await newController.finished;
  assert.equal(newDone, 1);
});

test('reduced motion and unsupported animation complete immediately without animating', async () => {
  installEnvironment({ stored: true });
  const reducedElement = fakeElement();
  let reducedDone = 0;
  const reduced = animateExit(reducedElement, 'drawer', () => { reducedDone += 1; });
  assert.equal(reducedDone, 1);
  assert.equal(reducedElement.calls.length, 0);
  await reduced.finished;

  installEnvironment();
  let unsupportedDone = 0;
  const unsupported = animateExit({}, 'backdrop', () => { unsupportedDone += 1; });
  assert.equal(unsupportedDone, 1);
  await unsupported.finished;
});

test('explicit and element cancellation prevent exit completion callbacks', async () => {
  installEnvironment();
  const element = fakeElement();
  let done = 0;
  const controller = animateExit(element, 'drawer', () => { done += 1; });
  assert.equal(cancelMotion(element), true);
  await controller.finished;
  assert.equal(done, 0);
  assert.equal(element.calls[0].animation.cancelCount, 1);
  assert.equal(cancelMotion(element), false);
});

test('a throwing completion callback still settles its controller', async () => {
  installEnvironment();
  const element = fakeElement();
  const controller = animateExit(element, 'dialog', () => { throw new Error('callback failed'); });
  element.calls[0].animation.resolve();
  await controller.finished;
  assert.equal(controller.settled, true);
});

test('shared CSS excludes official support selectors and defines accessible motion tokens', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /creator|support|donation|upi|amount-options|thank-you/i);
  assert.match(css, /--motion-feedback:\s*120ms/);
  assert.match(css, /--motion-page:\s*200ms/);
  assert.match(css, /--motion-overlay:\s*240ms/);
  assert.match(css, /--motion-exit:\s*160ms/);
  assert.match(css, /scale\(\.985\)/);
  assert.doesNotMatch(css, /scale\(\.97\)/);
});

test('official support stylesheet contains extracted creator and payment presentation', async () => {
  const css = await readFile(new URL('../official/support.css', import.meta.url), 'utf8');
  assert.match(css, /\.creator-credit/);
  assert.match(css, /\.support-card/);
  assert.match(css, /\.support-upi/);
  assert.match(css, /\.donation-options/);
  assert.match(css, /@media\s*\(max-width:\s*650px\)/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
});

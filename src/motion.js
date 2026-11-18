const QUERY = '(prefers-reduced-motion: reduce)';
const activeMotions = new WeakMap();
let launchPlayed = false;

const DURATION = Object.freeze({
  feedback: 120,
  page: 200,
  overlay: 240,
  exit: 160
});

const EASING = 'cubic-bezier(.22,.8,.25,1)';

const ENTRY_FRAMES = Object.freeze({
  page: Object.freeze([
    Object.freeze({ opacity: 0, transform: 'translateY(8px)' }),
    Object.freeze({ opacity: 1, transform: 'translateY(0)' })
  ]),
  launch: Object.freeze([
    Object.freeze({ opacity: 0, transform: 'translateY(10px) scale(.995)' }),
    Object.freeze({ opacity: 1, transform: 'translateY(0) scale(1)' })
  ]),
  dialog: Object.freeze([
    Object.freeze({ opacity: 0, transform: 'translateY(6px) scale(.985)' }),
    Object.freeze({ opacity: 1, transform: 'translateY(0) scale(1)' })
  ]),
  drawer: Object.freeze([
    Object.freeze({ opacity: 0, transform: 'translateX(-24px)' }),
    Object.freeze({ opacity: 1, transform: 'translateX(0)' })
  ]),
  backdrop: Object.freeze([
    Object.freeze({ opacity: 0, transform: 'translateZ(0)' }),
    Object.freeze({ opacity: 1, transform: 'translateZ(0)' })
  ])
});

const EXIT_FRAMES = Object.freeze({
  drawer: Object.freeze([
    Object.freeze({ opacity: 1, transform: 'translateX(0)' }),
    Object.freeze({ opacity: 0, transform: 'translateX(-12px)' })
  ]),
  backdrop: Object.freeze([
    Object.freeze({ opacity: 1, transform: 'translateZ(0)' }),
    Object.freeze({ opacity: 0, transform: 'translateZ(0)' })
  ]),
  dialog: Object.freeze([
    Object.freeze({ opacity: 1, transform: 'translateY(0) scale(1)' }),
    Object.freeze({ opacity: 0, transform: 'translateY(4px) scale(.985)' })
  ])
});

function immediateController(element, onDone, completed = true) {
  const controller = new MotionController(element, null, onDone);
  controller._settle(completed);
  return controller;
}

/**
 * Reports whether motion is disabled by WaveSync's stored preference or by
 * the operating system. The check is safe during server-side evaluation.
 */
export function reducedMotion() {
  try {
    if (typeof document !== 'undefined' && document.documentElement?.dataset?.reducedMotion === 'true') {
      return true;
    }
  } catch {}

  try {
    return typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true;
  } catch {
    return false;
  }
}

/**
 * A cancellable Web Animations handle. `finished` always resolves, including
 * after cancellation, and a cancelled or superseded exit never calls onDone.
 */
export class MotionController {
  constructor(element, animation = null, onDone = null) {
    this.element = element;
    this.animation = animation;
    this.onDone = onDone;
    this.settled = false;
    this.fallback = null;
    this.finished = new Promise(resolve => { this._resolve = resolve; });
  }

  cancel() {
    this._settle(false);
  }

  _settle(completed) {
    if (this.settled) return;
    this.settled = true;
    if (this.fallback !== null) clearTimeout(this.fallback);
    try { this.animation?.cancel(); } catch {}
    if (activeMotions.get(this.element) === this) activeMotions.delete(this.element);
    try {
      if (completed) this.onDone?.();
    } catch {
      // Completion cleanup must settle even if caller teardown fails.
    } finally {
      this._resolve();
    }
  }
}

function run(element, keyframes, options, onDone = null, phase = 'motion') {
  const previous = activeMotions.get(element);
  previous?.cancel();

  if (!element || typeof element.animate !== 'function' || reducedMotion()) {
    return immediateController(element, onDone);
  }

  let animation;
  try {
    animation = element.animate(keyframes, {
      duration: options.duration,
      easing: EASING,
      fill: 'both'
    });
  } catch {
    return immediateController(element, onDone);
  }

  const controller = new MotionController(element, animation, onDone);
  controller.phase = phase;
  activeMotions.set(element, controller);
  if (!animation.finished || typeof animation.finished.then !== 'function') {
    controller.fallback = setTimeout(() => controller._settle(true), options.duration + 80);
    controller.fallback?.unref?.();
    return controller;
  }
  Promise.resolve(animation.finished).then(
    () => controller._settle(true),
    () => controller._settle(false)
  );

  // Some embedded WebViews expose Web Animations but never settle `finished`.
  // Bound cleanup to the declared duration without delaying normal completion.
  controller.fallback = setTimeout(() => controller._settle(true), options.duration + 80);
  controller.fallback?.unref?.();
  return controller;
}

/**
 * Animates a page, standalone-PWA launch surface, or dialog once per element.
 * It never changes layout and returns immediately when motion is unavailable.
 */
export function animateEntry(element, kind = 'page') {
  if (kind === 'launch') {
    let standalone = false;
    try { standalone = window.matchMedia?.('(display-mode: standalone)').matches === true; } catch {}
    try { standalone ||= navigator.standalone === true; } catch {}
    if (!standalone || launchPlayed) return immediateController(element);
    launchPlayed = true;
  }

  const existing = activeMotions.get(element);
  if (existing?.phase === 'entry') return existing;

  const keyframes = ENTRY_FRAMES[kind] || ENTRY_FRAMES.page;
  const duration = ['dialog', 'drawer', 'backdrop'].includes(kind) ? DURATION.overlay : DURATION.page;
  return run(element, keyframes, { duration }, null, 'entry');
}

/**
 * Animates an overlay exit and calls onDone only for the latest successful
 * completion. Routing and state updates remain the caller's responsibility.
 */
export function animateExit(element, kind = 'drawer', onDone) {
  const keyframes = EXIT_FRAMES[kind] || EXIT_FRAMES.drawer;
  return run(element, keyframes, { duration: DURATION.exit }, onDone, 'exit');
}

/** Cancels the active entry or exit for an element without running onDone. */
export function cancelMotion(element) {
  const controller = activeMotions.get(element);
  if (!controller) return false;
  controller.cancel();
  return true;
}

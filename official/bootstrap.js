import { WaveSync } from '../src/app.js';
import { loadFeatures } from './features.js';
import { mountSupport } from './support.js';

const SUPPORT_ROUTE = 'support';
const routeFromHash = () => location.hash.replace(/^#/, '').split('/')[0].toLowerCase();

export async function mount(options = {}) {
  const requestedRoute = routeFromHash();
  const app = new WaveSync(options);
  window.wavesync = app;
  const navigate = app.ui.navigate.bind(app.ui);
  let navigationChanged = false;
  app.ui.navigate = (...args) => {
    navigationChanged = true;
    return navigate(...args);
  };
  const features = await loadFeatures();
  if (app.destroyed) return app;

  if (features.supportCreator === true) {
    const controller = mountSupport(app.ui);
    app.extensions = [...(app.extensions || []), controller];
    if (requestedRoute === SUPPORT_ROUTE && !navigationChanged && routeFromHash() === 'home') {
      navigate(SUPPORT_ROUTE, true);
    }
  }

  return app;
}

export function start(options) {
  return mount(options).then(app => {
    window.wavesync = app;
    return app;
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    start().catch(error => console.error('WaveSync failed to start.', error));
  });
}

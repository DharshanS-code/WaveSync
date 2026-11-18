import { WaveSync } from './app.js';
function start() { window.wavesync = new WaveSync(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

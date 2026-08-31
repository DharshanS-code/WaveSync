// ui.js — thin DOM layer. No framework; just query + update helpers.
const $ = (sel, root = document) => root.querySelector(sel);

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class UI {
  constructor() {
    this.screens = document.querySelectorAll('.screen');
    this.toastEl = $('#toast');
    this._toastT = null;
  }

  show(name) {
    this.screens.forEach((s) => s.classList.toggle('is-active', s.dataset.screen === name));
  }

  toast(msg, ms = 2400) {
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    this.toastEl.classList.add('is-show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => {
      this.toastEl.classList.remove('is-show');
      setTimeout(() => { this.toastEl.hidden = true; }, 250);
    }, ms);
  }

  set(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
  html(id, v) { const el = document.getElementById(id); if (el) el.innerHTML = v; }

  setBadge(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'status-row__v badge' + (kind ? ' badge--' + kind : '');
  }

  setDisc(prefix, playing) {
    const disc = document.getElementById(prefix + '-disc');
    if (disc) disc.classList.toggle('is-playing', !!playing);
  }

  connDot(state) {
    const dot = $('#conn-dot');
    const txt = $('#conn-text');
    if (dot) dot.className = 'conn-dot conn-dot--' + state;
    const labels = { on: 'Connected', off: 'Offline', wait: 'Connecting…' };
    if (txt) txt.textContent = labels[state] || 'Ready';
  }
}

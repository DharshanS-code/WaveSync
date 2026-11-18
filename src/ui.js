// WaveSync UI: DOM rendering and event delegation only. Audio and network state stay in app.js.
import { qrSvg } from './qr.js';
import { animateEntry, animateExit, reducedMotion } from './motion.js';
const byId = (id, root = document) => root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);

export function fmtTime(seconds) {
  const safe = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Number(seconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export class UI {
  constructor(root = document) {
    this.root = root;
    this.handlers = {};
    this.listeners = [];
    this.last = {};
    this.queue = [];
    this.devices = [];
    this.role = null;
    this.dragId = null;
    this.toastTimer = null;
    this.baseRoutes = new Set(['home', 'room', 'settings', 'privacy']);
    this.routes = new Set(this.baseRoutes);

    this.el = {};
    [
      'home-screen', 'room-screen', 'home-title', 'room-title', 'display-name', 'join-code',
      'home-error', 'home-network', 'home-network-text', 'signaling-setup',
      'theme-select', 'accent-select', 'room-theme-select', 'room-accent-select',
      'create-room', 'join-room', 'install-app', 'update-app', 'room-role', 'room-code',
      'copy-room', 'share-room', 'connection-pill', 'connection-text', 'track-art',
      'track-kicker', 'track-title', 'track-artist', 'transfer-state', 'transfer-text',
      'transfer-value', 'transfer-progress', 'audio-permission', 'seek-control',
      'guest-progress', 'position-time', 'duration-time', 'play-toggle', 'play-toggle-icon',
      'previous-track', 'next-track', 'volume-control', 'shuffle-toggle', 'repeat-toggle',
      'repeat-label', 'playback-status', 'audio-files', 'queue-list', 'queue-count',
      'queue-empty', 'devices-list', 'devices-empty', 'host-name', 'sync-text',
      'network-text', 'offline-help', 'toast'
    ].forEach((id) => { this.el[id] = byId(id, root); });

    this.view = 'home';
    this.drawerGeneration = 0;
    this._bindNavigation();
    this.launchMotion = animateEntry(byId('main-content', this.root), 'launch');
  }

  bind(handlers = {}) {
    this.handlers = handlers;
    const app = byId('app', this.root);
    if (!app) return this;

    this._listen(app, 'submit', (event) => {
      const form = event.target.closest('[data-form-action]');
      if (!form) return;
      event.preventDefault();
      const action = form.dataset.formAction;
      if (!form.reportValidity()) return;
      if (action === 'create') {
        this._call('create', this.el['display-name']?.value.trim() || '');
      } else if (action === 'join') {
        const code = this.el['join-code']?.value.trim().toUpperCase() || '';
        if (!code) return;
        this._call('join', code);
      }
    });

    this._listen(app, 'click', (event) => {
      const control = event.target.closest('[data-action]');
      if (!control || control.matches('input, select') || control.type === 'submit') return;
      const { action, id, direction } = control.dataset;
      if (!action || control.disabled) return;

      if (action === 'addMusic') {
        this.el['audio-files']?.click();
      } else if (action === 'selectTrack' || action === 'removeTrack') {
        this._call(action, id);
      } else if (action === 'moveTrack') {
        this._call(action, id, direction);
      } else if (action === 'shuffle') {
        this._call(action, control.getAttribute('aria-pressed') !== 'true');
      } else if (action === 'repeat') {
        const current = control.dataset.value || 'off';
        const next = current === 'off' ? 'all' : current === 'all' ? 'one' : 'off';
        this._call(action, next);
      } else if (action === 'play' && this.last.playing) {
        this._call('pause');
      } else {
        this._call(action);
      }
    });

    this._listen(app, 'change', (event) => {
      const control = event.target.closest('[data-action]');
      if (!control) return;
      const action = control.dataset.action;
      if (action === 'files') {
        this._call('files', control.files);
      } else if (['theme', 'accent', 'repeat', 'outputDevice'].includes(action)) {
        this._call(action, control.value);
      } else if (action === 'shuffle') {
        this._call(action, control.checked);
      }
    });

    this._listen(app, 'input', (event) => {
      const control = event.target.closest('input[data-action]');
      if (!control) return;
      if (control.dataset.action === 'seek' || control.dataset.action === 'volume') {
        this._call(control.dataset.action, Number(control.value));
      }
    });

    this._listen(app, 'dragstart', (event) => {
      const item = event.target.closest('.queue-item[draggable="true"]');
      if (!item) return;
      this.dragId = item.dataset.id;
      item.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', this.dragId);
    });
    this._listen(app, 'dragover', (event) => {
      const target = event.target.closest('.queue-item[draggable="true"]');
      if (!target || !this.dragId || target.dataset.id === this.dragId) return;
      event.preventDefault();
      target.classList.add('is-drop-target');
      event.dataTransfer.dropEffect = 'move';
    });
    this._listen(app, 'dragleave', (event) => {
      event.target.closest('.queue-item')?.classList.remove('is-drop-target');
    });
    this._listen(app, 'drop', (event) => {
      const target = event.target.closest('.queue-item[draggable="true"]');
      if (!target || !this.dragId || target.dataset.id === this.dragId) return;
      event.preventDefault();
      this._call('moveTrack', this.dragId, target.dataset.id, true);
      this._clearDragStyles();
    });
    this._listen(app, 'dragend', () => this._clearDragStyles());
    return this;
  }

  render(state = {}) {
    const next = { ...this.last, ...state };
    const changed = (key) => !Object.is(this.last[key], next[key]);
    const trackSignature = (track) => track
      ? [track.id, track.name, track.duration, track.artist].map((value) => String(value ?? '')).join('\u0000')
      : '';
    const trackChanged = trackSignature(this.last.track) !== trackSignature(next.track)
      || (changed('role') && !next.track);

    if (changed('screen')) {
      this.productScreen = next.screen === 'room' ? 'room' : 'home';
      this.navigate(this.last.screen === undefined && !next.role ? this._routeFromHash() : this.productScreen, true);
    }
    const active = Boolean(next.role);
    this.root.querySelectorAll('[data-active-room]').forEach(element => { element.hidden = !active; });
    const banner = byId('active-room-banner', this.root);
    if (banner) banner.hidden = !active;
    const signalingUnavailable = next.signalingConfigured === false;
    this._disabled('create-room', active || !next.online || signalingUnavailable);
    this._disabled('join-room', active || !next.online || signalingUnavailable);
    if (this.el['signaling-setup']) this.el['signaling-setup'].hidden = !signalingUnavailable;
    if (changed('role')) {
      this.role = next.role === 'host' ? 'host' : next.role === 'guest' ? 'guest' : null;
      this.root.querySelectorAll('[data-host-only]').forEach((element) => { element.hidden = this.role !== 'host'; });
      this.root.querySelectorAll('[data-guest-only]').forEach((element) => { element.hidden = this.role !== 'guest'; });
      if (this.el['seek-control']) this.el['seek-control'].hidden = this.role === 'guest';
      if (this.el['guest-progress']) this.el['guest-progress'].hidden = this.role !== 'guest';
      this._text('room-role', this.role === 'host' ? 'Hosting' : this.role === 'guest' ? 'Listening as guest' : 'Room');
      this.renderQueue(this.queue, next.track?.id ?? this.last.track?.id ?? null);
    }
    if (changed('name') && this.el['display-name'] && !this.el['display-name'].matches(':focus')) {
      this.el['display-name'].value = next.name || '';
    }
    if (changed('code')) {
      this._text('room-code', next.code || '—');
      const unavailable = !next.code;
      this._disabled('copy-room', unavailable);
      this._disabled('share-room', unavailable);
    }
    if (changed('connection')) this._renderConnection(next.connection);
    if (trackChanged) {
      const track = next.track;
      this._text('track-kicker', track ? 'Now playing' : this.role === 'guest' ? 'Waiting for the host' : 'Nothing playing');
      this._text('track-title', track?.name || 'No track selected');
      this._text('track-artist', track?.artist || (track ? (this.role === 'guest' ? 'Shared directly by the host' : 'Local audio · browser decoded') : this.role === 'guest' ? 'The host has not selected music yet.' : 'Choose local audio to begin.'));
      this.progress(0, track?.duration || 0);
      this.renderQueue(this.queue, track?.id ?? null);
    }
    if (changed('playing')) {
      this.el['track-art']?.classList.toggle('is-playing', Boolean(next.playing));
      if (this.el['play-toggle']) {
        this.el['play-toggle'].dataset.action = next.playing ? 'play' : 'play';
        this.el['play-toggle'].setAttribute('aria-label', next.playing ? 'Pause' : 'Play');
      }
      this.el['play-toggle-icon']?.setAttribute('href', next.playing ? '#icon-pause' : '#icon-play');
    }
    if (changed('loading') || trackChanged) {
      const blocked = Boolean(next.loading) || !next.track;
      this._disabled('play-toggle', blocked);
      this._disabled('seek-control', blocked || this.role !== 'host');
    }
    if (changed('audioEnabled') || changed('screen') || changed('role')) {
      if (this.el['audio-permission']) {
        this.el['audio-permission'].hidden = !(next.screen === 'room' && this.role === 'guest' && next.audioEnabled === false);
      }
    }
    if (changed('transfer')) this._renderTransfer(next.transfer);
    if (changed('status')) this._text('playback-status', next.status || '');
    if (changed('syncText')) this._text('sync-text', next.syncText || 'Unavailable');
    if (changed('networkText')) this._text('network-text', next.networkText || 'Unavailable');
    if (changed('volume') && this.el['volume-control']) this.el['volume-control'].value = this._unit(next.volume, 1);
    if (changed('theme')) this._applyPreference('theme', next.theme || 'system');
    if (changed('accent')) this._applyPreference('accent', next.accent || 'coral');
    if (changed('repeat')) this._renderRepeat(next.repeat || 'off');
    if (changed('shuffle') && this.el['shuffle-toggle']) {
      this.el['shuffle-toggle'].setAttribute('aria-pressed', String(Boolean(next.shuffle)));
    }
    if (changed('online')) this._renderOnline(next.online);
    if (changed('hostName')) this._text('host-name', next.hostName || 'Unknown');
    if (changed('canPrevious') || changed('loading')) this._disabled('previous-track', !next.canPrevious || Boolean(next.loading));
    if (changed('canNext') || changed('loading')) this._disabled('next-track', !next.canNext || Boolean(next.loading));

    if (Object.prototype.hasOwnProperty.call(state, 'installAvailable')) {
      this.el['install-app'].hidden = !state.installAvailable;
    }
    if (Object.prototype.hasOwnProperty.call(state, 'updateAvailable')) {
      this.el['update-app'].hidden = !state.updateAvailable;
    }
    if (Object.prototype.hasOwnProperty.call(state, 'homeError')) this._text('home-error', state.homeError || '');

    const resync = byId('settings-resync', this.root);
    if (resync) resync.disabled = next.role !== 'guest';
    this._text('settings-network', next.networkText || 'Not in a room.');
    if (byId('settings-repeat', this.root)) byId('settings-repeat', this.root).value = next.repeat || 'off';
    if (byId('settings-shuffle', this.root)) byId('settings-shuffle', this.root).checked = Boolean(next.shuffle);
    if (next.settings) this.renderSettings(next.settings, next);
    this.last = next;
  }

  progress(position, duration) {
    const safeDuration = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : 0;
    const safePosition = Number.isFinite(Number(position)) && Number(position) > 0
      ? Math.min(Number(position), safeDuration || Number(position))
      : 0;
    this._text('position-time', fmtTime(safePosition));
    this._text('duration-time', fmtTime(safeDuration));
    if (this.el['seek-control']) {
      this.el['seek-control'].max = String(safeDuration || 1);
      this.el['seek-control'].value = String(safePosition);
      this.el['seek-control'].setAttribute('aria-valuetext', `${fmtTime(safePosition)} of ${fmtTime(safeDuration)}`);
    }
    if (this.el['guest-progress']) {
      this.el['guest-progress'].max = safeDuration || 1;
      this.el['guest-progress'].value = safePosition;
      this.el['guest-progress'].textContent = safeDuration ? `${Math.round((safePosition / safeDuration) * 100)}%` : '0%';
    }
  }

  notify(message, error = false) {
    if (!this.el.toast || !message) return;
    clearTimeout(this.toastTimer);
    this.el.toast.textContent = String(message);
    this.el.toast.classList.toggle('is-error', Boolean(error));
    this.el.toast.setAttribute('role', error ? 'alert' : 'status');
    this.el.toast.hidden = false;
    this.toastTimer = setTimeout(() => { this.el.toast.hidden = true; }, error ? 5200 : 2800);
  }

  renderDevices(devices = []) {
    this.devices = Array.isArray(devices) ? devices.slice() : [];
    const list = this.el['devices-list'];
    if (!list) return;
    list.replaceChildren();
    this.el['devices-empty'].hidden = this.devices.length > 0;

    this.devices.forEach((device) => {
      const item = document.createElement('li');
      item.className = 'device-item';
      const dot = document.createElement('span');
      dot.className = 'device-dot';
      dot.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('div');
      copy.className = 'device-copy';
      const name = document.createElement('strong');
      name.textContent = device?.name || 'Unnamed device';
      const detail = document.createElement('span');
      detail.textContent = device?.detail || device?.status || 'Connected';
      copy.append(name, detail);
      const badge = document.createElement('span');
      badge.className = 'device-badge';
      badge.textContent = device?.role === 'host' ? 'Host' : device?.role === 'guest' ? 'Guest' : '';
      item.append(dot, copy, badge);
      list.append(item);
    });
  }

  renderQueue(queue = [], currentId = null) {
    this.queue = Array.isArray(queue) ? queue.slice() : [];
    const list = this.el['queue-list'];
    if (!list) return;
    list.replaceChildren();
    this.el['queue-empty'].hidden = this.queue.length > 0;
    this._text('queue-count', `${this.queue.length} ${this.queue.length === 1 ? 'track' : 'tracks'}`);

    this.queue.forEach((track, index) => {
      const id = String(track?.id ?? '');
      const item = document.createElement('li');
      item.className = `queue-item${id && String(currentId) === id ? ' is-current' : ''}`;
      item.dataset.id = id;
      item.draggable = this.role === 'host' && Boolean(id);

      const main = document.createElement(this.role === 'host' ? 'button' : 'div');
      main.className = 'queue-select';
      if (this.role === 'host') {
        main.type = 'button';
        main.dataset.action = 'selectTrack';
        main.dataset.id = id;
        main.setAttribute('aria-label', `Play ${track?.name || `track ${index + 1}`}`);
      }
      const number = document.createElement('span');
      number.className = 'queue-index';
      number.textContent = String(index + 1);
      const name = document.createElement('span');
      name.className = 'queue-name';
      name.textContent = track?.name || 'Untitled track';
      main.append(number, name);
      item.append(main);

      if (this.role === 'host') {
        const actions = document.createElement('div');
        actions.className = 'queue-actions';
        actions.append(
          this._queueButton('moveTrack', id, 'up', 'Move up', '#icon-chevron-up', index === 0),
          this._queueButton('moveTrack', id, 'down', 'Move down', '#icon-chevron-down', index === this.queue.length - 1),
          this._queueButton('removeTrack', id, '', 'Remove track', '#icon-trash', false)
        );
        item.append(actions);
      }
      list.append(item);
    });
  }

  reset() {
    this.last = {};
    this.role = null;
    this.queue = [];
    this.devices = [];
    this.renderQueue([], null);
    this.renderDevices([]);
    this.progress(0, 0);
    this._text('home-error', '');
    if (this.el['join-code']) this.el['join-code'].value = '';
    if (this.el['audio-files']) this.el['audio-files'].value = '';
    if (this.el['transfer-state']) this.el['transfer-state'].hidden = true;
    if (this.el['audio-permission']) this.el['audio-permission'].hidden = true;
    this._showScreen('home');
  }

  destroy() {
    this.listeners.forEach(({ target, type, listener, options }) => target.removeEventListener(type, listener, options));
    this.listeners = [];
    clearTimeout(this.toastTimer);
    if (this.el.toast) this.el.toast.hidden = true;
    this._closeDrawer(false, true);
    // Teardown cancels intent; reduced-motion cleanup may complete valid intent.
    this.dialogExit?.cancel();
    this.dialogClosing = false;
    this.dialogResult = 'cancel';
    const dialog = byId('confirm-dialog', this.root);
    if (dialog?.open) dialog.close('cancel');
    this._stopMotion();
    this.handlers = {};
  }

  // Compatibility aliases for older callers during the app-layer migration.
  show(screen) { this._showScreen(screen === 'host' || screen === 'guest' ? 'room' : screen); }
  toast(message) { this.notify(message); }

  _listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.listeners.push({ target, type, listener, options });
  }

  _call(action, ...args) {
    const handler = this.handlers?.[action];
    if (typeof handler === 'function') handler(...args);
  }

  _text(id, value) {
    const element = this.el[id] || byId(id, this.root);
    const text = String(value ?? '');
    if (element && element.textContent !== text) element.textContent = text;
  }

  _disabled(id, value) {
    const element = this.el[id];
    if (element && element.disabled !== Boolean(value)) element.disabled = Boolean(value);
  }

  _showScreen(screen) {
    const changed = this.view !== screen;
    if (changed) this.pageMotion?.cancel();
    this.view = screen;
    this.root.querySelectorAll('[data-screen]').forEach(element => {
      const active = element.dataset.screen === screen;
      element.hidden = !active;
      element.classList.toggle('is-active', active);
    });
    this.root.querySelectorAll('[data-route]').forEach(element => {
      if (element.dataset.route === screen) element.setAttribute('aria-current', 'page');
      else element.removeAttribute('aria-current');
    });
    this._closeDrawer(false);
    if (changed) this.pageMotion = animateEntry(byId(`${screen}-screen`, this.root), 'page');
    requestAnimationFrame(() => {
      if (this.drawerOpen || this.view !== screen) return;
      const section = location.hash.split('/')[1];
      const target = section && /^[a-z]+$/.test(section) ? byId(`${screen}-${section}`, this.root) : null;
      if (target) target.scrollIntoView({ block: 'start' });
      byId(`${screen}-title`, this.root)?.focus({ preventScroll: true });
    });
  }

  _routeFromHash() { return location.hash.replace(/^#/, '').split('/')[0] || 'home'; }

  navigate(screen, replace = false) {
    const route = this._normalizeRoute(screen);
    let safe = this.routes.has(route) ? route : 'home';
    if (safe === 'room' && this.productScreen !== 'room') safe = 'home';
    if (this._routeFromHash() !== safe) {
      const url = new URL(location.href); url.hash = safe;
      history[replace ? 'replaceState' : 'pushState'](null, '', url);
    }
    this._showScreen(safe);
    this._call('view', safe);
  }

  registerRoute(route) {
    const safe = this._normalizeRoute(route);
    if (!safe) return false;
    this.routes.add(safe);
    return true;
  }

  unregisterRoute(route) {
    const safe = this._normalizeRoute(route);
    if (!safe || this.baseRoutes.has(safe)) return false;
    const removed = this.routes.delete(safe);
    if (removed && this.view === safe) this.navigate('home', true);
    return removed;
  }

  _normalizeRoute(route) {
    const value = String(route ?? '').trim().replace(/^#/, '').split('/')[0].toLowerCase();
    return /^[a-z][a-z0-9-]*$/.test(value) ? value : '';
  }

  _bindNavigation() {
    this._listen(window, 'hashchange', () => { this.navigate(this._routeFromHash(), true); });
    this._listen(window, 'popstate', () => { this.navigate(this._routeFromHash(), true); });
    const skip = this.root.querySelector('.skip-link');
    if (skip) this._listen(skip, 'click', event => {
      event.preventDefault();
      byId('main-content', this.root)?.focus();
    });
    const app = byId('app', this.root);
    this._listen(app, 'click', event => {
      const anchor = event.target.closest('a[href^="#"]');
      if (anchor && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        if (anchor.classList.contains('skip-link')) return;
        event.preventDefault();
        const hash = anchor.getAttribute('href');
        if (location.hash !== hash) history.pushState(null, '', hash);
        this.navigate(hash.slice(1).split('/')[0], true);
      }
    });
    this._listen(app, 'change', event => {
      const control = event.target.closest('[data-setting]');
      if (!control || control.type === 'range') return;
      this._call('setting', control.dataset.setting, control.type === 'checkbox' ? control.checked : control.value);
    });
    this._listen(app, 'input', event => {
      const control = event.target.closest('input[type="range"][data-setting]');
      if (control) this._call('setting', control.dataset.setting, Number(control.value));
    });
    this._listen(byId('nav-open', this.root), 'click', () => this._openDrawer());
    this._listen(byId('nav-close', this.root), 'click', () => this._closeDrawer());
    this._listen(byId('nav-backdrop', this.root), 'click', () => this._closeDrawer());
    this._listen(document, 'keydown', event => {
      if (!this.drawerOpen) return;
      if (event.key === 'Escape') this._closeDrawer();
      if (event.key === 'Tab') this._trapFocus(event, byId('sidebar', this.root));
    });
    this._listen(window, 'resize', () => { if (innerWidth >= 960) this._closeDrawer(false, true); });
    const motionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (motionMedia?.addEventListener) this._listen(motionMedia, 'change', () => { if (reducedMotion()) this._stopMotion(); });
    const confirmation = byId('confirm-dialog', this.root);
    this._listen(confirmation, 'keydown', event => {
      if (confirmation.open && event.key === 'Tab') this._trapFocus(event, confirmation);
    });
    this._listen(confirmation, 'cancel', event => { event.preventDefault(); this._dismissConfirmation('cancel'); });
    this._listen(confirmation.querySelector('form'), 'submit', event => {
      event.preventDefault(); this._dismissConfirmation(event.submitter?.value || 'cancel');
    });
    this._listen(confirmation, 'click', event => {
      if (event.target !== confirmation) return;
      const bounds = confirmation.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        this._dismissConfirmation('cancel');
      }
    });
  }

  _openDrawer() {
    if (innerWidth >= 960 || this.drawerOpen) return;
    ++this.drawerGeneration;
    this.drawerExit?.cancel(); this.backdropExit?.cancel();
    this.drawerReturnFocus = document.activeElement;
    this.drawerOpen = true;
    const sidebar = byId('sidebar', this.root);
    sidebar.inert = false;
    byId('nav-backdrop', this.root).style.pointerEvents = '';
    sidebar.classList.add('is-open'); sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true');
    this.drawerEntry = animateEntry(sidebar, 'drawer');
    byId('nav-backdrop', this.root).hidden = false;
    this.backdropEntry = animateEntry(byId('nav-backdrop', this.root), 'backdrop');
    byId('nav-open', this.root).setAttribute('aria-expanded', 'true');
    byId('main-content', this.root).inert = true;
    this.root.querySelector('.mobile-header').inert = true;
    this.scrollBeforeDrawer = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Wait one frame for visibility styles to apply before focusing the formerly hidden drawer.
    requestAnimationFrame(() => { if (this.drawerOpen) byId('nav-close', this.root).focus(); });
  }

  _closeDrawer(restore = true, immediate = false) {
    const sidebar = byId('sidebar', this.root), backdrop = byId('nav-backdrop', this.root);
    if (!this.drawerOpen) {
      if (immediate) {
        ++this.drawerGeneration; this.drawerExit?.cancel(); this.backdropExit?.cancel();
        sidebar?.classList.remove('is-open'); if (sidebar) sidebar.inert = false;
        if (backdrop) { backdrop.hidden = true; backdrop.style.pointerEvents = ''; }
      }
      return;
    }
    this.drawerOpen = false;
    const generation = ++this.drawerGeneration;
    this.drawerEntry?.cancel(); this.backdropEntry?.cancel();
    sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); sidebar.inert = true;
    backdrop.style.pointerEvents = 'none';
    byId('nav-open', this.root).setAttribute('aria-expanded', 'false');
    byId('main-content', this.root).inert = false;
    this.root.querySelector('.mobile-header').inert = false;
    document.body.style.overflow = this.scrollBeforeDrawer || '';
    if (restore) this.drawerReturnFocus?.focus();
    const finishSidebar = () => { if (generation !== this.drawerGeneration) return; sidebar.classList.remove('is-open'); sidebar.inert = false; };
    const finishBackdrop = () => { if (generation !== this.drawerGeneration) return; backdrop.hidden = true; backdrop.style.pointerEvents = ''; };
    if (immediate || innerWidth >= 960) { finishSidebar(); finishBackdrop(); }
    else {
      this.drawerExit = animateExit(sidebar, 'drawer', finishSidebar);
      this.backdropExit = animateExit(backdrop, 'backdrop', finishBackdrop);
    }
  }

  renderSettings(settings, state = {}) {
    const notificationKeys = { notifyRoom: 'room', notifyPlayback: 'playback', notifyTransfer: 'transfer', notifyReconnect: 'reconnect' };
    this.root.querySelectorAll('[data-setting]').forEach(control => {
      const key = control.dataset.setting;
      const value = notificationKeys[key] ? settings.notifications?.[notificationKeys[key]] : settings[key];
      if (control.type === 'checkbox') control.checked = value === true;
      else if (value !== undefined) control.value = String(value);
    });
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion === true);
    if (reducedMotion()) this._stopMotion();
    this._text('default-volume-value', `${Math.round(settings.defaultVolume * 100)}%`);
    const channel = byId('channel-control', this.root);
    if (channel) channel.hidden = !settings.channelEnabled;
    const selector = byId('player-channel', this.root);
    if (selector && typeof state.channelSupported === 'boolean') selector.disabled = !state.channelSupported;
    if (state.channelHelp) this._text('channel-help', state.channelHelp);
  }

  renderQR(id, text) {
    const container = byId(id, this.root);
    if (!container || !text) return;
    if (container.dataset.value === text) return;
    try { container.innerHTML = qrSvg(text); container.dataset.value = text; }
    catch { container.textContent = 'QR unavailable. Use the copy or share action instead.'; }
  }

  async confirm(title, description) {
    const dialog = byId('confirm-dialog', this.root);
    if (dialog.open) return false;
    this._text('confirm-title', title); this._text('confirm-description', description);
    const previous = document.activeElement;
    return new Promise(resolve => {
      const finish = () => { dialog.removeEventListener('close', finish); previous?.focus(); resolve(dialog.returnValue === 'confirm'); };
      dialog.addEventListener('close', finish);
      this.dialogClosing = false;
      dialog.returnValue = 'cancel'; dialog.showModal();
      this.dialogEntry = animateEntry(dialog, 'dialog');
    });
  }

  _dismissConfirmation(result = 'cancel') {
    const dialog = byId('confirm-dialog', this.root);
    if (!dialog?.open || this.dialogClosing) return;
    this.dialogClosing = true;
    this.dialogEntry?.cancel();
    this.dialogResult = result;
    this.dialogExit = animateExit(dialog, 'dialog', () => {
      this.dialogClosing = false;
      if (dialog.open) dialog.close(result);
    });
  }

  _stopMotion() {
    for (const handle of [this.pageMotion,this.launchMotion,this.drawerEntry,this.backdropEntry,this.dialogEntry]) handle?.cancel();
    if (!this.drawerOpen) this._closeDrawer(false, true);
    if (this.dialogClosing) {
      this.dialogExit?.cancel(); this.dialogClosing = false;
      const dialog = byId('confirm-dialog', this.root);
      if (dialog?.open) dialog.close(this.dialogResult || 'cancel');
    }
  }

  _renderConnection(connection) {
    const values = typeof connection === 'object' && connection
      ? connection
      : { state: String(connection || 'idle'), text: '' };
    const labels = {
      idle: 'Ready', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…',
      disconnected: 'Disconnected', error: 'Connection error'
    };
    const state = values.state || 'idle';
    this._text('connection-text', values.text || labels[state] || state);
    this.el['connection-pill']?.setAttribute('data-state', state);
  }

  _renderTransfer(transfer) {
    const panel = this.el['transfer-state'];
    if (!panel) return;
    if (!transfer) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const value = Number(transfer.progress);
    const hasProgress = Number.isFinite(value);
    const percent = hasProgress ? Math.max(0, Math.min(100, value <= 1 ? value * 100 : value)) : 0;
    this._text('transfer-text', transfer.text || transfer.label || transfer.state || 'Preparing audio…');
    this._text('transfer-value', hasProgress ? `${Math.round(percent)}%` : 'In progress');
    this.el['transfer-progress'].value = percent;
    this.el['transfer-progress'].removeAttribute('aria-valuetext');
    if (!hasProgress) this.el['transfer-progress'].setAttribute('aria-valuetext', 'Progress unavailable');
  }

  _renderOnline(online) {
    if (typeof online !== 'boolean') return;
    this.el['home-network']?.classList.toggle('is-online', online);
    this.el['home-network']?.classList.toggle('is-offline', !online);
    this._text('home-network-text', online ? 'Network available' : 'Offline — rooms need a network connection');
    if (this.el['offline-help']) this.el['offline-help'].hidden = online;
    // Create/join availability is owned by render(), which also knows the active role.
  }

  _applyPreference(kind, value) {
    const allowed = kind === 'theme' ? ['system', 'light', 'dark'] : ['coral', 'rose', 'amber'];
    const safe = allowed.includes(value) ? value : allowed[0];
    document.documentElement.dataset[kind] = safe;
    const first = this.el[`${kind}-select`];
    const second = this.el[`room-${kind}-select`];
    if (first) first.value = safe;
    if (second) second.value = safe;
    if (kind === 'theme') {
      const dark = safe === 'dark' || (safe === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151715' : '#f7f7f5');
    }
  }

  _renderRepeat(repeat) {
    if (!this.el['repeat-toggle']) return;
    const value = ['off', 'all', 'one'].includes(repeat) ? repeat : 'off';
    this.el['repeat-toggle'].dataset.value = value;
    this.el['repeat-toggle'].classList.toggle('is-active', value !== 'off');
    this.el['repeat-toggle'].setAttribute('aria-label', `Repeat ${value}`);
    this._text('repeat-label', value === 'one' ? 'Repeat one' : value === 'all' ? 'Repeat all' : 'Repeat');
  }

  _queueButton(action, id, direction, label, icon, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button';
    button.dataset.action = action;
    button.dataset.id = id;
    if (direction) button.dataset.direction = direction;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', icon);
    svg.append(use);
    button.append(svg);
    return button;
  }

  _unit(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
  }

  _clearDragStyles() {
    this.dragId = null;
    this.root.querySelectorAll('.is-dragging, .is-drop-target').forEach((item) => item.classList.remove('is-dragging', 'is-drop-target'));
  }

  _trapFocus(event, container) {
    const items = [...container.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter(item => item.getClientRects().length && !item.closest('[hidden]'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}

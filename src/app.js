// app.js — WaveSync orchestrator. Wires signaling, WebRTC, audio + sync engines
// and the UI for both host and guest roles.
import { CONFIG } from './config.js';
import { AudioEngine } from './audio-engine.js';
import { SyncEngine } from './sync-engine.js';
import { SignalClient, PeerManager } from './network.js';
import { UI, fmtTime } from './ui.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

class WaveSync {
  constructor() {
    this.ui = new UI();
    this.audio = new AudioEngine();
    this.signal = null;
    this.peers = null;
    this.sync = null;         // guest SyncController
    this.role = null;
    this.code = null;
    this.seq = 0;             // host timeline sequence
    this.hbTimer = null;      // host heartbeat
    this.tickTimer = null;    // ui tick
    this.fileBuffer = null;   // host: raw bytes of the current track
    this.fileMeta = null;
    this.queue = [];          // host: [{ file, name, mime }]
    this.qIndex = 0;
    this.gbuffers = {};        // guest: decoded AudioBuffers by track index
    this.activeIndex = 0;
    this._bind();
    this._autoJoin();
    this._registerSW();
  }

  // ---------- setup ----------
  _bind() {
    this._bindSupport();
    document.getElementById('btn-create').onclick = () => this.createRoom();
    document.getElementById('btn-open-join').onclick = () => {
      const p = document.getElementById('join-panel');
      p.hidden = !p.hidden;
      if (!p.hidden) document.getElementById('join-code').focus();
    };
    document.getElementById('btn-join').onclick = () => this.joinRoom();
    document.getElementById('join-code').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });
    document.getElementById('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinRoom(); });

    // Host controls
    document.getElementById('host-file').addEventListener('change', (e) => this.onFiles(e.target.files));
    document.getElementById('host-prev').onclick = () => this.prevTrack();
    document.getElementById('host-next').onclick = () => this.nextTrack();
    document.getElementById('host-play').onclick = () => this.togglePlay();
    document.getElementById('host-seek').addEventListener('input', (e) => this.onSeek(e.target.value));
    document.getElementById('host-vol').addEventListener('input', (e) => this.audio.setVolume(e.target.value / 100));
    document.getElementById('guest-vol').addEventListener('input', (e) => this.audio.setVolume(e.target.value / 100));

    // Leave / share (delegated)
    document.querySelectorAll('[data-action="leave"]').forEach((b) => b.onclick = () => this.leave());
    document.querySelectorAll('[data-action="share"]').forEach((b) => b.onclick = () => this.share());

    window.addEventListener('beforeunload', () => { if (this.signal) this.signal.close(); });
  }

  _bindSupport() {
    const overlay = document.getElementById('support-overlay');
    const open = () => { overlay.hidden = false; requestAnimationFrame(() => overlay.classList.add('is-open')); };
    const close = () => { overlay.classList.remove('is-open'); setTimeout(() => { overlay.hidden = true; }, 260); };
    document.getElementById('support-fab').onclick = open;
    document.getElementById('support-close').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
    document.getElementById('support-copy').onclick = async () => {
      try { await navigator.clipboard.writeText('dharshandcu@nyes'); this.ui.toast('UPI ID copied'); }
      catch (e) { this.ui.toast('dharshandcu@nyes'); }
    };
  }

  // ---------- calibration ----------
  _startCalibration(role) {
    const steps = role === 'host'
      ? [['link', 'Connecting to room'], ['clock', 'Syncing shared clock'], ['lock', 'Locking timeline']]
      : [['join', 'Joining room'], ['peer', 'Linking device · P2P'], ['clock', 'Syncing shared clock'], ['ready', 'Preparing playback']];
    this._calib = { role, done: false, state: {} };
    document.getElementById('calib-steps').innerHTML = steps.map(([k, label]) =>
      `<li class="calib-step" data-k="${k}" data-testid="calib-step-${k}"><span class="calib-step__dot"></span><span>${label}</span></li>`).join('');
    document.getElementById('calib-title').textContent = 'Calibrating sync';
    document.getElementById('calib-metric').textContent = 'Measuring latency…';
    const ov = document.getElementById('calibration');
    ov.hidden = false;
    requestAnimationFrame(() => ov.classList.add('is-open'));
    this._calibMark(steps[0][0], 'active');
    clearTimeout(this._calibTO);
    this._calibTO = setTimeout(() => this._finishCalibration(true), CONFIG.calibMaxWaitMs);
  }

  _calibMark(k, state) {
    const li = document.querySelector(`#calib-steps [data-k="${k}"]`);
    if (!li) return;
    if (state === 'done') { li.classList.add('is-done'); li.classList.remove('is-active'); }
    else li.classList.add('is-active');
  }

  _calibProgress(evt, d) {
    const c = this._calib;
    if (!c || c.done) return;
    if (d && isFinite(d.rtt)) {
      document.getElementById('calib-metric').textContent =
        `RTT ${Math.round(d.rtt)} ms · offset ${Math.round(d.offset)} ms · ${Math.round((d.confidence || 0) * 100)}%`;
    }
    const clockReady = d && d.confidence >= CONFIG.calibMinConfidence && d.samples >= CONFIG.calibMinSamples;
    if (c.role === 'host') {
      if (evt === 'created') { c.state.link = 1; this._calibMark('link', 'done'); this._calibMark('clock', 'active'); }
      if (evt === 'clock' && clockReady && !c.state.clock) {
        c.state.clock = 1; this._calibMark('clock', 'done');
        this._calibMark('lock', 'active'); this._calibMark('lock', 'done');
        this._finishCalibration();
      }
    } else {
      if (evt === 'joined') { c.state.join = 1; this._calibMark('join', 'done'); this._calibMark('peer', 'active'); }
      if (evt === 'peer' && !c.state.peer) { c.state.peer = 1; this._calibMark('peer', 'done'); this._calibMark('clock', 'active'); }
      if (evt === 'clock' && clockReady && !c.state.clock) { c.state.clock = 1; this._calibMark('clock', 'done'); this._calibMark('ready', 'active'); }
      if (c.state.peer && c.state.clock) { this._calibMark('ready', 'done'); this._finishCalibration(); }
    }
  }

  _finishCalibration(timedout) {
    const c = this._calib;
    if (!c || c.done) return;
    c.done = true;
    clearTimeout(this._calibTO);
    document.getElementById('calib-title').textContent = timedout ? 'Ready' : 'Synced';
    setTimeout(() => this._hideCalibration(), 500);
  }

  _hideCalibration() {
    clearTimeout(this._calibTO);
    const ov = document.getElementById('calibration');
    if (!ov) return;
    ov.classList.remove('is-open');
    setTimeout(() => { ov.hidden = true; }, 320);
  }

  _autoJoin() {
    const code = new URLSearchParams(location.search).get('room');
    if (code) {
      document.getElementById('btn-open-join').click();
      document.getElementById('join-code').value = code.toUpperCase();
    }
  }

  async _registerSW() {
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('./sw.js'); } catch (e) {}
    }
  }

  // ---------- signaling lifecycle ----------
  _makeSignal(code, role, name) {
    const s = new SignalClient(CONFIG.signalUrl, CONFIG);
    this.signal = s;
    this.code = code;
    this.role = role;
    this.ui.connDot('wait');

    s.addEventListener('reconnecting', () => this.ui.connDot('wait'));
    s.addEventListener('ws-close', () => this.ui.connDot('wait'));
    s.addEventListener('error', (e) => this._onSignalError(e.detail.msg));
    s.addEventListener('clock', (e) => this._onClock(e.detail));

    this.peers = new PeerManager(s, CONFIG);

    if (role === 'host') this._wireHost();
    else this._wireGuest();

    s.connect(code, role, name);
  }

  _onSignalError(msg) {
    if (this.role === 'guest' && !this.audio.hasAudio()) {
      const el = document.getElementById('join-error');
      el.textContent = msg || 'Could not join room';
      this.signal.close();
      this.signal = null;
      this.ui.show('home');
    } else {
      this.ui.toast(msg || 'Signaling error');
    }
  }

  _onClock(d) {
    const txt = d.rtt === Infinity ? '—' : `${Math.round(d.offset)}ms (RTT ${Math.round(d.rtt)}ms)`;
    if (this.role === 'host') this.ui.set('host-offset', txt);
    else this.ui.set('guest-rtt', d.rtt === Infinity ? '—' : `${Math.round(d.rtt)}ms`);
    this.ui.connDot('on');
    this._calibProgress('clock', d);
  }

  // ---------- HOST ----------
  createRoom() {
    const code = newCode();
    this.ui.set('host-code', code);
    this.ui.show('host');
    this._startCalibration('host');
    this._makeSignal(code, 'host', 'Host');
    this.audio.resume();
  }

  _wireHost() {
    const s = this.signal;
    this.audio.onEnded = () => this._onTrackEnd();
    s.addEventListener('created', (e) => { this.ui.set('host-code', e.detail.code); this._calibProgress('created'); });

    // When a guest's datachannel opens, push the current track + timeline.
    this.peers.addEventListener('dc-open', (e) => {
      this._updateDeviceCount();
      const peer = e.detail.peer;
      if (this.fileBuffer && this.fileMeta) {
        peer.sendFile(this.fileBuffer, this.fileMeta);
        this.signal.control({ kind: 'track', index: this.qIndex, name: this.fileMeta.name, duration: this.fileMeta.duration, count: this.queue.length });
      }
      this._broadcastTimeline();
    });
    this.peers.addEventListener('roster', () => this._updateDeviceCount());
    this.peers.addEventListener('peer-state', () => this._updateDeviceCount());

    this._startUiTick();
  }

  onFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    this.queue = files.map((f) => ({ file: f, name: f.name.replace(/\.[^.]+$/, ''), mime: f.type || 'audio/mpeg' }));
    this.qIndex = 0;
    this._renderQueue();
    this.loadTrack(0, false);
  }

  async loadTrack(i, autoplay) {
    if (i < 0 || i >= this.queue.length) return;
    this.qIndex = i;
    const item = this.queue[i];
    this.ui.set('host-sub', 'Decoding…');
    try {
      await this.audio.resume();
      const ab = await item.file.arrayBuffer();
      this.fileBuffer = ab.slice(0);
      const dur = await this.audio.decode(ab);
      this.fileMeta = { name: item.name, mime: item.mime, duration: dur, index: i };
      document.getElementById('host-play').disabled = false;
      this.ui.set('host-title', item.name);
      this.ui.set('host-sub', `Track ${i + 1} of ${this.queue.length}`);
      this.ui.set('host-dur', fmtTime(dur));
      this._renderQueue();
      this._setMediaSession(item.name);
      this.peers.broadcastFile(this.fileBuffer, this.fileMeta);
      this.signal.control({ kind: 'track', index: i, name: item.name, duration: dur, count: this.queue.length });
      if (autoplay) { this.audio.play(0); this._syncPlayIcon(); this.ui.setDisc('host', true); }
      this._broadcastTimeline();
      this._preloadNext(i + 1);
    } catch (err) {
      this.ui.set('host-sub', 'Unsupported / corrupt track');
      this.ui.toast('Could not decode this track');
    }
  }

  // Transfer the next queued track ahead of time for near-gapless handoff.
  async _preloadNext(i) {
    if (i < 0 || i >= this.queue.length) return;
    try {
      const ab = await this.queue[i].file.arrayBuffer();
      this.peers.broadcastFile(ab, { name: this.queue[i].name, mime: this.queue[i].mime, index: i });
    } catch (e) {}
  }

  _onTrackEnd() {
    if (this.role !== 'host') return;
    if (this.qIndex + 1 < this.queue.length) this.loadTrack(this.qIndex + 1, true);
    else { this._syncPlayIcon(); this.ui.setDisc('host', false); this._broadcastTimeline(); }
  }

  nextTrack() { const p = this.audio.playing; if (this.qIndex + 1 < this.queue.length) this.loadTrack(this.qIndex + 1, p); }
  prevTrack() { const p = this.audio.playing; if (this.qIndex > 0) this.loadTrack(this.qIndex - 1, p); }

  _renderQueue() {
    const el = document.getElementById('host-queue');
    if (!el) return;
    el.innerHTML = this.queue.map((q, idx) =>
      `<li class="queue-item ${idx === this.qIndex ? 'is-current' : ''}" data-idx="${idx}" data-testid="queue-item-${idx}"><span class="queue-item__n">${idx + 1}</span><span class="queue-item__name">${q.name}</span></li>`).join('');
    el.querySelectorAll('.queue-item').forEach((li) => { li.onclick = () => this.loadTrack(Number(li.dataset.idx), this.audio.playing); });
  }

  togglePlay() {
    if (!this.audio.hasAudio()) return;
    if (this.audio.playing) this.audio.pause();
    else this.audio.play();
    this._syncPlayIcon();
    this.ui.setDisc('host', this.audio.playing);
    this._broadcastTimeline();
  }

  onSeek(v) {
    if (!this.audio.hasAudio()) return;
    const pos = (v / 1000) * this.audio.duration;
    this.audio.seek(pos, this.audio.playing);
    this._broadcastTimeline();
  }

  _broadcastMeta() {
    if (!this.fileMeta) return;
    this.signal.control({ kind: 'meta', name: this.fileMeta.name, duration: this.fileMeta.duration });
  }

  _broadcastTimeline() {
    if (!this.signal) return;
    this.seq++;
    // Broadcast the HEARD position (scheduled minus output latency) so every
    // device aligns on the same audible timeline.
    const pos = this.audio.playing
      ? Math.max(0, this.audio.position() - this.audio.outputLatency())
      : this.audio.position();
    this.signal.control({
      kind: 'timeline',
      playing: this.audio.playing,
      position: pos,
      atServerTime: this.signal.clock.now(),
      seq: this.seq
    });
  }

  _updateDeviceCount() {
    let connected = 0;
    for (const p of this.peers.peers.values()) if (p.connected) connected++;
    this.ui.set('host-devices', String(1 + connected));
  }

  // ---------- GUEST ----------
  joinRoom() {
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const name = document.getElementById('join-name').value.trim();
    const err = document.getElementById('join-error');
    err.textContent = '';
    if (code.length < 4) { err.textContent = 'Enter a valid room code'; return; }
    this.ui.set('guest-code', code);
    this.ui.show('guest');
    this._startCalibration('guest');
    this._makeSignal(code, 'guest', name || 'Guest');
    this.audio.resume();
    this.sync = new SyncEngine(this.audio, this.signal.clock, CONFIG);
    this.sync.onStatus = (st) => this._onSyncStatus(st);
  }

  _wireGuest() {
    const s = this.signal;
    s.addEventListener('joined', (e) => {
      this.ui.set('guest-code', e.detail.code);
      this.ui.setBadge('guest-conn', 'In room · linking…', 'wait');
      this._calibProgress('joined');
    });
    s.addEventListener('control', (e) => this._onControl(e.detail));
    s.addEventListener('host-left', () => {
      this.ui.setBadge('guest-conn', 'Host left', 'bad');
      this.ui.set('guest-sub', 'Host disconnected');
      if (this.sync) this.sync.stop();
      this.audio.pause();
    });

    this.peers.addEventListener('peer-state', (e) => {
      const st = e.detail.state;
      if (st === 'connected') { this.ui.setBadge('guest-conn', 'P2P connected', 'good'); this._calibProgress('peer'); }
      else if (st === 'connecting') this.ui.setBadge('guest-conn', 'Linking…', 'wait');
      else if (st === 'failed') this.ui.setBadge('guest-conn', 'Link failed · retrying', 'bad');
    });
    this.peers.addEventListener('file-start', (e) => {
      this.ui.set('guest-sub', 'Receiving audio…');
    });
    this.peers.addEventListener('file-progress', (e) => {
      if (e.detail.index === this.activeIndex) this.ui.set('guest-buffer', Math.round(e.detail.ratio * 100) + '%');
    });
    this.peers.addEventListener('file-done', async (e) => {
      const idx = e.detail.meta.index != null ? e.detail.meta.index : 0;
      try {
        await this.audio.resume();
        this.gbuffers[idx] = await this.audio.decodeToBuffer(e.detail.buffer);
        if (idx === this.activeIndex) this._activateGuestTrack(idx);
      } catch (err) { this.ui.set('guest-sub', 'Decode failed'); }
    });

    this._startUiTick();
  }

  _activateGuestTrack(idx) {
    const buf = this.gbuffers[idx];
    if (!buf) { this.ui.set('guest-sub', 'Receiving audio…'); return; }
    this.audio.setBuffer(buf);
    this.ui.set('guest-buffer', '100%');
    this.ui.set('guest-dur', fmtTime(this.audio.duration));
    this.ui.set('guest-sub', 'Ready · syncing');
    if (!this.sync.scheduler.running) this.sync.start();
    else if (this.sync.timeline) this.sync.setTimeline(this.sync.timeline);
    this._setMediaSession(this.fileMeta ? this.fileMeta.name : 'WaveSync');
  }

  _onControl(m) {
    const d = m.data;
    if (!d) return;
    if (d.kind === 'track') {
      this.activeIndex = d.index || 0;
      this.fileMeta = { name: d.name, duration: d.duration, index: this.activeIndex };
      this.ui.set('guest-title', d.name);
      this.ui.set('guest-dur', fmtTime(d.duration));
      if (d.count) this.ui.set('guest-sub', `Track ${this.activeIndex + 1} of ${d.count}`);
      if (this.gbuffers[this.activeIndex]) this._activateGuestTrack(this.activeIndex);
      else { this.ui.set('guest-sub', 'Receiving audio…'); this.ui.set('guest-buffer', '0%'); }
    } else if (d.kind === 'timeline') {
      const tl = { playing: d.playing, position: d.position, atServerTime: d.atServerTime, seq: d.seq };
      if (this.sync) this.sync.setTimeline(tl);
      this._setGuestPlayState(d.playing);
      this.ui.setDisc('guest', d.playing);
    }
  }

  _onSyncStatus(st) {
    const ms = Math.round(st.error * 1000);
    const cls = Math.abs(ms) < 30 ? 'good' : Math.abs(ms) < 120 ? 'wait' : 'bad';
    const el = document.getElementById('guest-err');
    el.textContent = `${ms >= 0 ? '+' : ''}${ms} ms`;
    el.className = 'status-row__v badge badge--' + cls;
  }

  _setGuestPlayState(playing) {
    const wrap = document.getElementById('guest-playstate');
    wrap.classList.toggle('is-playing', playing);
    this.ui.set('guest-playstate-text', playing ? 'Playing' : 'Paused');
  }

  // ---------- shared UI tick / heartbeat ----------
  _startUiTick() {
    this._stopTimers();
    this.tickTimer = setInterval(() => this._tick(), 250);
    if (this.role === 'host') this.hbTimer = setInterval(() => this._broadcastTimeline(), CONFIG.timelineHeartbeatMs);
  }

  _stopTimers() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.tickTimer = this.hbTimer = null;
  }

  _tick() {
    const dur = this.audio.duration || 0;
    const pos = this.audio.position();
    if (this.role === 'host') {
      this.ui.set('host-cur', fmtTime(pos));
      const seek = document.getElementById('host-seek');
      if (document.activeElement !== seek && dur) seek.value = String(Math.round((pos / dur) * 1000));
      this._syncPlayIcon();
    } else {
      this.ui.set('guest-cur', fmtTime(pos));
      const fill = document.getElementById('guest-progress');
      if (fill && dur) fill.style.width = ((pos / dur) * 100) + '%';
    }
  }

  _syncPlayIcon() {
    this.ui.html('host-play-icon', this.audio.playing ? 'Pause' : 'Play');
  }

  // ---------- media session ----------
  _setMediaSession(title) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'WaveSync', album: 'Room ' + (this.code || '') });
      if (this.role === 'host') {
        navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
        navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
      }
    } catch (e) {}
  }

  // ---------- misc ----------
  async share() {
    const url = `${location.origin}${location.pathname}?room=${this.code}`;
    const data = { title: 'WaveSync', text: `Join my WaveSync room ${this.code}`, url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(url); this.ui.toast('Room link copied'); }
    } catch (e) {
      try { await navigator.clipboard.writeText(url); this.ui.toast('Room link copied'); } catch (_) { this.ui.toast(url); }
    }
  }

  leave() {
    this._stopTimers();
    this._hideCalibration();
    if (this.sync) this.sync.destroy();
    this.audio.pause();
    if (this.peers) this.peers.closeAll();
    if (this.signal) this.signal.close();
    this.signal = this.peers = this.sync = null;
    this.role = this.code = null;
    this.fileBuffer = this.fileMeta = null;
    this.queue = []; this.qIndex = 0; this.gbuffers = {}; this.activeIndex = 0;
    if (this.audio) this.audio.onEnded = null;
    this.ui.connDot('off');
    this.ui.show('home');
    history.replaceState(null, '', location.pathname);
  }
}

window.addEventListener('DOMContentLoaded', () => { window.wavesync = new WaveSync(); });

import { readPreference, savePreference } from './config.js';
import { readPreferences, setPreferences, resetPreferences, clearWaveSyncData, getStorageSummary } from './preferences.js';

// Local preferences never enter room messages. Capability requests are explicit user actions.
export class SettingsController {
  constructor(app) {
    this.app = app;
    this.preferences = readPreferences();
    const stored = Number(readPreference('volume', this.preferences.defaultVolume));
    this.volume = this.preferences.rememberVolume && Number.isFinite(stored) ? Math.max(0, Math.min(1, stored)) : this.preferences.defaultVolume;
    this.notificationBusy = false;
    this.notificationGeneration = 0;
  }

  apply() {
    const { audio, sync } = this.app;
    audio.setVolume(this.volume);
    audio.setChannelMode?.(this.preferences.channelEnabled ? this.preferences.channelMode : 'off');
    sync?.setAutomatic(this.preferences.autoSync);
    this.app.patch({ settings: this.preferences, volume: audio.volume });
    this.diagnostics();
  }

  async change(key, value) {
    let update;
    const notificationKeys = { notifyRoom: 'room', notifyPlayback: 'playback', notifyTransfer: 'transfer', notifyReconnect: 'reconnect' };
    if (notificationKeys[key]) update = { notifications: { ...this.preferences.notifications, [notificationKeys[key]]: value === true } };
    else if (key === 'defaultVolume') {
      if (!Number.isFinite(value)) return;
      update = { defaultVolume: Math.max(0, Math.min(1, value)) };
    } else if (key === 'channelMode') {
      if (!['off', 'left', 'right'].includes(value)) return;
      update = { channelMode: value };
    } else if (['rememberVolume', 'channelEnabled', 'autoSync', 'soundEffects', 'browserNotifications', 'reducedMotion'].includes(key)) {
      update = { [key]: value === true };
    } else return;
    if (key === 'browserNotifications' && value !== true) ++this.notificationGeneration;
    if (key === 'browserNotifications' && value === true) {
      if (this.notificationBusy) return;
      const generation = ++this.notificationGeneration;
      this.notificationBusy = true;
      try {
        if (!('Notification' in globalThis)) throw new Error('Browser notifications are unavailable. In-app messages still work.');
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (generation !== this.notificationGeneration) return;
        if (permission !== 'granted') throw new Error('Notification permission was not granted. In-app messages still work.');
      } catch (error) {
        if (generation !== this.notificationGeneration) return;
        update.browserNotifications = false;
        this.app.ui.notify(error.message, true);
      } finally { this.notificationBusy = false; }
    }
    this.preferences = { ...this.preferences, ...update };
    if (key === 'defaultVolume' && !this.preferences.rememberVolume) this.volume = this.preferences.defaultVolume;
    if (key === 'rememberVolume') {
      if (this.preferences.rememberVolume) savePreference('volume', this.app.audio.volume);
      else this.volume = this.preferences.defaultVolume;
    }
    if (!setPreferences(update)) this.app.ui.notify('Preference applied for this visit; browser storage is unavailable.', true);
    this.apply();
  }

  setVolume(value) {
    if (!Number.isFinite(value)) return;
    this.app.audio.setVolume(value); this.volume = this.app.audio.volume;
    if (this.preferences.rememberVolume && !savePreference('volume', this.volume)) this.app.ui.notify('Volume cannot be saved in this browser.', true);
    this.app.patch({ volume: this.volume });
  }

  event(kind, message, error = false) {
    if (!this.preferences.notifications[kind] && !error) return;
    this.app.ui.notify(message, error);
    if (this.preferences.browserNotifications && document.visibilityState === 'hidden' && globalThis.Notification?.permission === 'granted') {
      const options = { body: message, tag: `wavesync-${kind}` };
      if (this.app.registration?.showNotification) {
        this.app.registration.showNotification('WaveSync', options).catch(() => this.app.ui.notify('Browser notification could not be shown; in-app messages still work.', true));
      } else {
        try { new Notification('WaveSync', options); }
        catch { this.app.ui.notify('This browser needs an installed service worker for notifications; in-app messages still work.', true); }
      }
    }
    const ctx = this.app.audio.ctx;
    if (this.preferences.soundEffects && ctx?.state === 'running') {
      const tone = ctx.createOscillator(), gain = ctx.createGain(), start = ctx.currentTime;
      tone.frequency.value = error ? 330 : 660;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.025, start + 0.01);
      gain.gain.linearRampToValueAtTime(0, start + 0.12);
      tone.connect(gain); gain.connect(ctx.destination); tone.start(start); tone.stop(start + 0.13);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
    }
  }

  async reset(clear = false) {
    const accepted = await this.app.ui.confirm(clear ? 'Clear local WaveSync data?' : 'Reset your preferences?', clear
      ? 'Remove locally stored preferences, device name and recent track history. This will not delete server data or leave your current room.'
      : 'Restore appearance, audio and playback defaults. Your device name and recent track history will stay.');
    if (!accepted) return;
    ++this.notificationGeneration;
    const result = clear ? clearWaveSyncData() : resetPreferences();
    if (result.available === false || result.failedKeys?.length) { this.app.ui.notify('Some local data could not be removed. Check browser site settings.', true); return; }
    this.preferences = readPreferences(); this.volume = this.preferences.defaultVolume;
    this.app.patch({ theme: 'system', accent: 'coral', repeat: 'off', shuffle: false, ...(clear && !this.app.state.role ? { name: '' } : {}) });
    this.apply();
    this.app.ui.notify(clear ? 'Local WaveSync data cleared. Active room unchanged.' : 'Preferences reset.');
  }

  async chooseOutput() {
    if (!navigator.mediaDevices?.selectAudioOutput) { this.app.ui.notify('Your browser does not offer an audio-output picker. Use your device settings.', true); return; }
    const device = await navigator.mediaDevices.selectAudioOutput();
    const select = document.getElementById('output-device');
    if (![...select.options].some(option => option.value === device.deviceId)) {
      const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || 'Selected output'; select.append(option);
    }
    await this.outputDevice(device.deviceId); select.value = device.deviceId;
  }

  async outputDevice(id) {
    await this.app.audio.resume();
    if (typeof this.app.audio.ctx?.setSinkId !== 'function') throw new Error('This browser cannot route Web Audio to a selected output. Use device settings.');
    if (!await this.app.audio.setOutputDevice(id)) throw new Error('Audio output selection is unavailable. Use device settings.');
    this.app.ui.notify('Local audio output changed.'); this.diagnostics();
  }

  diagnostics() {
    const { audio, signal, sync, quality, ui } = this.app;
    const set = (id, text) => { const element = document.getElementById(id); if (element && element.textContent !== text) element.textContent = text; };
    const summary = getStorageSummary();
    set('storage-summary', summary.available ? `${summary.count} WaveSync storage keys · approximately ${summary.approxBytes} bytes. Stores preferences and up to 20 recent track names, not audio or resume tokens.` : 'Local browser storage is unavailable; preferences only apply to this visit.');
    set('audio-diagnostic', audio.ctx ? `Audio context: ${audio.ctx.state} · ${audio.ctx.sampleRate} Hz · ${audio.buffer?.numberOfChannels || 0} source channels. Output mapping: ${audio.outputMapping().source} (estimate, not acoustic measurement).` : 'Audio has not been activated. Tap Enable audio to request playback.');
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    const sink = typeof audio.ctx?.setSinkId === 'function' || typeof AC?.prototype?.setSinkId === 'function';
    document.getElementById('output-device').disabled = !sink;
    document.getElementById('choose-output').disabled = !sink || !navigator.mediaDevices?.selectAudioOutput;
    set('output-help', sink ? 'Output choices require an explicit browser picker where supported. No microphone permission is requested.' : 'This browser cannot select a Web Audio output. Use your device’s sound settings.');
    set('notification-help', !('Notification' in globalThis) ? 'Browser notifications are unavailable. In-app messages still work.' : `Optional when the tab is hidden. Browser permission: ${Notification.permission}.`);
    const clock = signal?.clock.quality();
    const profile = quality.profile();
    const rows = [
      ['Clock offset', clock?.synced ? `${Math.round(signal.clock.offset)} ms · symmetric-path estimate` : 'Not calibrated'],
      ['Clock uncertainty', clock?.synced ? `±${Math.round(clock.uncertaintyMs)} ms · not output accuracy` : 'Unavailable'],
      ['Scheduler', sync ? `${sync.state} · observed timer variation ${Math.round(sync.scheduler.jitterMs || 0)} ms` : 'Not a guest in a room'],
      ['Automatic sync', this.preferences.autoSync ? 'On' : 'Off · manual alignment only'],
      ['Transfer handoff', profile.throughputBytesSec ? `${(profile.throughputBytesSec / 1024).toFixed(1)} KiB/s · sender/backpressure estimate` : 'Not measured'],
      ['Wi-Fi hardware', 'RSSI, band, channel and PHY rate unavailable']
    ];
    const dl = document.getElementById('advanced-diagnostics');
    const signature = JSON.stringify(rows);
    if (dl.dataset.signature !== signature) {
      dl.replaceChildren();
      for (const [label, value] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; dl.append(dt, dd); }
      dl.dataset.signature = signature;
    }
    const channelSupported = audio.supportsChannelSelection !== false;
    const channelHelp = audio.buffer?.numberOfChannels === 1 ? 'Mono source: Left and Right retain the same mono audio.' : !channelSupported ? 'Channel selection is unavailable in this browser. Normal stereo is preserved.' : 'Only changes this device. Left or Right selects that source channel; Off restores stereo.';
    ui.renderSettings(this.preferences, { channelSupported, channelHelp });
  }
}

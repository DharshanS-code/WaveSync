import { CONFIG, readPreference, savePreference, validateSignalUrl } from './config.js';
import { AudioEngine } from './audio-engine.js';
import { SyncEngine } from './sync-engine.js';
import { SignalClient, PeerManager } from './network.js';
import { NetworkQuality } from './network-quality.js';
import { TrackStore, BufferCache } from './track-store.js';
import { UI } from './ui.js';
import { validCode, validTrack, validTimeline } from '../shared/protocol.js';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCode() {
  const bytes = new Uint8Array(6); crypto.getRandomValues(bytes);
  return [...bytes].map(value => alphabet[value % alphabet.length]).join('');
}
const mediaActions = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'];

export class WaveSync {
  constructor({ ui = new UI(), audio = new AudioEngine() } = {}) {
    this.ui = ui; this.audio = audio;
    this.signal = null; this.peers = null; this.sync = null;
    this.store = new TrackStore(); this.cache = new BufferCache();
    this.quality = new NetworkQuality();
    this.session = 0; this.selection = 0; this.seq = 0; this.revision = 0;
    this.transport = 0; this.hostAvailable = false;
    this.pendingDecodeIds = new Set();
    this.epoch = null; this.activeId = null; this.hostId = null;
    this.fileBuffer = null; this.fileMeta = null; this.roster = [];
    this.decodeChain = Promise.resolve(); this.listeners = []; this.sessionListeners = [];
    this.state = { screen: 'home', role: null, name: readPreference('name', ''), code: '',
      connection: 'disconnected', track: null, playing: false, loading: false,
      audioEnabled: false, transfer: null, status: '', syncText: 'Not in a room',
      networkText: 'Wi-Fi hardware information unavailable in browsers', volume: 1,
      theme: ['system','dark','light'].includes(readPreference('theme')) ? readPreference('theme') : 'system',
      accent: ['coral','rose','amber'].includes(readPreference('accent')) ? readPreference('accent') : 'coral',
      repeat: ['off','all','one'].includes(readPreference('repeat')) ? readPreference('repeat') : 'off',
      shuffle: readPreference('shuffle') === 'true',
      signalUrl: CONFIG.signalUrl, online: navigator.onLine, hostName: '',
      canPrevious: false, canNext: false, installAvailable: false, updateAvailable: false };
    this.ui.bind(this.handlers());
    this.ui.render(this.state);
    const query = new URLSearchParams(location.search);
    const invite = query.get('room');
    if (invite) document.getElementById('join-code').value = invite.toUpperCase();
    if (query.has('signal')) {
      try { validateSignalUrl(query.get('signal')); }
      catch (error) { this.patch({ signalError: error.message }); }
    }
    this.listen(window, 'online', () => this.patch({ online: true }));
    this.listen(window, 'offline', () => this.patch({ online: false }));
    this.listen(window, 'pagehide', () => this.leave());
    this.listen(document, 'keydown', event => this.shortcut(event));
    this.listen(this.quality, 'change', () => this.networkStatus());
    this.audio.addLifecycleListener(state => {
      this.patch({ audioEnabled: state === 'running', playing: this.audio.playing });
      if (state !== 'running' && this.state.role === 'host' && this.fileMeta) {
        this.revision++; this.publishTimeline(); this.patch({ status: 'Audio interrupted. Tap Play to resume.' });
      }
    });
    this.registerPWA();
  }
  handlers() {
    const safe = fn => (...args) => { try { return Promise.resolve(fn(...args)).catch(error => this.fail(error)); } catch(error) { this.fail(error); } };
    return { create: safe(name => this.connect(roomCode(), 'host', name)),
      join: safe(code => this.connect(code, 'guest', document.getElementById('display-name').value)),
      leave: () => this.leave(), files: safe(files => this.addFiles(files)),
      play: safe(() => this.play()), pause: () => this.pause(),
      seek: safe(position => this.seek(position)), volume: value => { this.audio.setVolume(value); this.patch({ volume: this.audio.volume }); },
      previous: safe(() => this.adjacent(-1)), next: safe(() => this.adjacent(1)),
      selectTrack: safe(id => this.loadTrack(id, this.audio.playing)),
      removeTrack: safe(id => this.removeTrack(id)), moveTrack: (id,target,drop) => { this.store.move(id,target,drop); this.renderQueue(); },
      repeat: value => { savePreference('repeat', value); this.patch({ repeat: value }); this.renderQueue(); },
      shuffle: value => { savePreference('shuffle',value); this.patch({ shuffle:value }); this.renderQueue(); },
      copy: safe(() => this.copyInvite()), share: safe(() => this.shareInvite()),
      resync: safe(() => this.resync()), enableAudio: safe(() => this.enableAudio()),
      theme: value => { savePreference('theme',value); this.patch({ theme:value }); },
      accent: value => { savePreference('accent',value); this.patch({ accent:value }); },
      signal: value => {
        if (this.signal) return this.fail(new Error('Leave the room before changing the signaling server.'));
        try { const url=validateSignalUrl(value); savePreference('signal',url); this.patch({signalUrl:url,signalError:''}); this.ui.notify('Signaling server saved.'); }
        catch(error){this.patch({signalError:error.message});}
      }, install: safe(() => this.install()), update: safe(() => this.update()) };
  }
  listen(target, type, fn, session = false) {
    target.addEventListener(type, fn);
    (session ? this.sessionListeners : this.listeners).push(() => target.removeEventListener(type,fn));
  }
  patch(values) { Object.assign(this.state,values); this.ui.render(this.state); }
  fail(error) {
    const message = error?.message || String(error);
    this.ui.notify(message,true);
    if (this.state.screen === 'home') this.patch({homeError:message});
    else this.patch({status:message});
  }
  async enableAudio() {
    const session = this.session;
    await this.audio.resume();
    if (session !== this.session) return;
    this.patch({audioEnabled:this.audio.ctx.state === 'running'});
    if (this.sync && this.cache.get(this.activeId)) this.activateGuest(this.activeId);
  }
  async connect(code, role, name) {
    if (this.signal) return;
    code=String(code).trim().toUpperCase();
    if (!validCode(code)) throw new Error('Enter a six-character room code.');
    if (!navigator.onLine) throw new Error('Network access is required to create or join a room.');
    if (!globalThis.RTCPeerConnection) throw new Error('WebRTC is not supported in this browser.');
    if (!globalThis.isSecureContext) throw new Error('Open WaveSync using HTTPS, or localhost for development.');
    validateSignalUrl(this.state.signalUrl);
    const session=++this.session;
    this.quality.destroy(); this.quality=new NetworkQuality();
    this.listen(this.quality,'change',()=>this.networkStatus(),true);
    const cfg={...CONFIG,networkQuality:this.quality};
    this.signal=new SignalClient(this.state.signalUrl,cfg);
    this.peers=new PeerManager(this.signal,cfg);
    this.patch({screen:'room',role,code,name:String(name||role).trim().slice(0,40),connection:'connecting',
      track:null,playing:false,loading:false,transfer:null,status:'Connecting to the room…',homeError:'',hostName:role==='host'?name:'Unknown'});
    savePreference('name',this.state.name);
    if(role==='guest'){
      this.sync=new SyncEngine(this.audio,this.signal.clock,cfg);
      this.sync.onStatus=status=>{
        if(session!==this.session)return;
        this.patch({playing:this.audio.playing,syncText:this.audio.ctx?.state==='running'&&this.sync.ready()
          ? `${status.state} · estimated playback error ${Math.round(status.error*1000)} ms (not acoustic measurement)`
          : 'Waiting for audio, the host timeline, or clock calibration'});
      };
    }
    const on=(target,type,fn)=>this.listen(target,type,event=>{if(session===this.session)fn(event.detail);},true);
    on(this.signal,role==='host'?'created':'joined',welcome=>this.welcome(welcome));
    on(this.signal,'clock',()=>{ this.networkStatus(); if(role==='host')this.publishTimeline(); else if(this.activeId)this.activateGuest(this.activeId); });
    on(this.signal,'reconnecting',()=>this.patch({connection:'reconnecting',status:'Signaling interrupted. Reconnecting…'}));
    on(this.signal,'ws-close',()=>{
      this.quality.setInterrupted(true); this.audio.pause(); this.sync?.stop(); this.revision++;
      this.hostAvailable = false; ++this.transport;
      if (this.sync) this.sync.timeline = null;
      this.patch({connection:'reconnecting',playing:false,status:'Signaling lost. Playback paused until recovery.'});
    });
    on(this.signal,'error',message=>{
      if(!this.epoch || message.fatal){this.leave();this.fail(new Error(message.msg||message.message||'Could not enter room.'));}
      else this.fail(new Error(message.msg||message.message||'Signaling error.'));
    });
    on(this.signal,'control',message=>this.control(message));
    on(this.signal,'roster',message=>{this.roster=message.peers||message.participants||[];this.renderDevices();});
    on(this.signal,'peer-join',peer=>{this.roster=this.roster.filter(p=>p.id!==peer.id).concat({...peer,online:true});this.renderDevices();});
    on(this.signal,'peer-leave',peer=>{this.roster=this.roster.filter(p=>p.id!==peer.id);this.renderDevices();});
    on(this.signal,'host-left',message=>{
      this.hostAvailable = false;
      this.sync?.stop();this.audio.pause();
      if (this.sync) this.sync.timeline = null;
      this.patch({playing:false,connection:message.recovering?'reconnecting':'disconnected',status:message.recovering?'Host disconnected. Waiting for recovery…':'Host left the room. You can leave and join another room.'});
    });
    on(this.signal,'host-restored',message=>{
      this.hostId=message.host||message.id||this.hostId;
      this.hostAvailable = true;
      if (this.sync) this.sync.timeline = null;
      this.patch({connection:'connected',status:'Host restored. Rebuilding the audio connection…'});
      if(message.track)this.control({from:this.hostId,data:message.track});
      if(message.timeline)this.control({from:this.hostId,data:message.timeline});
    });
    on(this.peers,'peer-state',()=>this.renderDevices());
    on(this.peers,'roster',()=>this.renderDevices());
    on(this.peers,'dc-open',({peer})=>{
      this.renderDevices();
      if(role==='host'&&this.fileBuffer&&this.fileMeta){
        peer.sendFile(this.fileBuffer,this.fileMeta).catch(error=>this.fail(error));
        this.signal.control(this.fileMeta);this.publishTimeline();
      }else this.patch({connection:'connected',status:this.state.track?'Preparing audio…':'Connected. Waiting for the host to select music.'});
    });
    on(this.peers,'dc-close',()=>this.renderDevices());
    on(this.peers,'file-start',({id,meta})=>{
      if(role!=='guest'||id!==this.hostId||meta.epoch!==this.epoch)return;
      if(meta.trackId===this.activeId)this.patch({transfer:{progress:0,state:'receiving'},status:'Receiving audio…'});
    });
    on(this.peers,'file-progress',({id,trackId,ratio})=>{
      if(role==='guest'&&id===this.hostId&&trackId===this.activeId)this.patch({transfer:{progress:ratio,state:'receiving'}});
    });
    on(this.peers,'file-done',event=>this.receiveFile(event,session));
    on(this.peers,'transfer-error',event=>this.fail(new Error(event.message||'Audio transfer failed. Reconnect or resync to retry.')));
    on(this.peers,'p2p-latency',event=>{this.quality.peerSample(event);this.sync?.reportP2pSample(event.rtt);});
    this.audio.onEnded=()=>{if(this.state.role==='host')this.adjacent(1,true).catch(error=>this.fail(error));};
    this.signal.connect(code,role,this.state.name);
    this.audio.resume().then(()=>{if(session===this.session)this.patch({audioEnabled:true});})
      .catch(()=>{if(session===this.session)this.patch({audioEnabled:false});});
    this.heartbeat=setInterval(()=>this.publishTimeline(),CONFIG.timelineHeartbeatMs);
    this.uiTick=setInterval(()=>{
      if(document.visibilityState!=='hidden')this.ui.progress(this.audio.position(),this.audio.duration);
    },250);
  }
  welcome(welcome) {
    this.hostId=welcome.host|| (this.state.role==='host'?welcome.id:null);
    if(this.epoch&&this.epoch!==welcome.epoch){this.cache.clear();this.audio.clear();this.activeId=null;this.fileMeta=null;this.fileBuffer=null;}
    this.epoch=welcome.epoch;this.sync?.setEpoch(this.epoch);
    this.roster=welcome.peers||[];
    this.hostAvailable = this.state.role === 'host' || this.roster.some(p => p.id === this.hostId && p.online !== false);
    if (this.sync) this.sync.timeline = null;
    this.seq=Math.max(this.seq,welcome.timeline?.seq||0);
    this.patch({connection:'connected',status:this.state.role==='host'?'Room created. Add local audio to begin.':'Joined. Connecting directly to the host…',
      hostName:this.roster.find(p=>p.id===this.hostId)?.name|| (this.state.role==='host'?this.state.name:'Host')});
    this.renderDevices();
    if(this.state.role==='guest'){
      if(welcome.track)this.control({from:this.hostId,data:welcome.track});
      if(welcome.timeline)this.control({from:this.hostId,data:welcome.timeline});
    }else if(this.fileMeta){this.fileMeta={...this.fileMeta,epoch:this.epoch};this.signal.control(this.fileMeta);this.publishTimeline();}
    this.setMediaSession();
  }
  async addFiles(files) {
    if(this.state.role!=='host')return;
    const added=this.store.append(files);this.renderQueue();
    document.getElementById('audio-files').value='';
    if(!this.activeId&&added.length)await this.loadTrack(added[0].id,false);
  }
  async decode(bytes) {
    const task=this.decodeChain.then(()=>this.audio.decodeToBuffer(bytes));
    this.decodeChain=task.then(()=>undefined,()=>undefined);return task;
  }
  async loadTrack(id,autoplay=false) {
    if(this.state.role!=='host')return;
    const item=this.store.get(id);if(!item)return;
    const session=this.session, selection=++this.selection;
    ++this.transport;
    this.audio.pause();this.revision++;this.publishTimeline();
    this.patch({loading:true,playing:false,status:'Reading and decoding audio…'});
    try{
      const bytes=await item.file.arrayBuffer();
      if(session!==this.session||selection!==this.selection)return;
      let buffer=this.cache.get(id);
      if(!buffer)buffer=await this.decode(bytes);
      if(session!==this.session||selection!==this.selection)return;
      this.cache.set(id,buffer,id);this.audio.setBuffer(buffer);this.activeId=id;this.store.currentId=id;
      item.duration=buffer.duration;
      this.fileBuffer=bytes;this.fileMeta={kind:'track',epoch:this.epoch,trackId:id,name:item.name,mime:item.mime,size:bytes.byteLength,duration:buffer.duration};
      this.patch({track:{id,name:item.name,duration:buffer.duration},loading:false,transfer:null,status:'Ready. Press Play to start the shared timeline.'});
      this.renderQueue();this.signal.control(this.fileMeta);this.revision++;
      this.peers.broadcastFile(bytes,this.fileMeta).then(results=>{
        if(session===this.session&&selection===this.selection&&results?.some(r=>r.status==='rejected'))this.ui.notify('Some devices could not receive the track. Check their connection.',true);
      }).catch(error=>{if(session===this.session)this.fail(error);});
      if(autoplay)await this.play();else this.publishTimeline();
      this.setMediaSession();this.recordHistory(item);
      this.prefetchNext(session,selection);
    }catch(error){
      if(session===this.session&&selection===this.selection){this.patch({loading:false,status:'Could not decode this audio. Try another browser-supported file.'});throw error;}
    }
  }
  async prefetchNext(session,selection) {
    if(!this.quality.profile().prefetchNext)return;
    const id=this.store.adjacent(1);const item=this.store.get(id);if(!item)return;
    try{
      const bytes=await item.file.arrayBuffer();
      if(session!==this.session||selection!==this.selection)return;
      const buffer=await this.decode(bytes);
      if(session!==this.session||selection!==this.selection)return;
      this.cache.set(id,buffer,this.activeId);item.duration=buffer.duration;
      const meta={kind:'track',epoch:this.epoch,trackId:id,name:item.name,mime:item.mime,size:bytes.byteLength,duration:buffer.duration};
      await this.peers.broadcastFile(bytes,meta);
    }catch(error){if(session===this.session&&selection===this.selection)this.ui.notify(`Next-track preload unavailable: ${error.message}`);}
  }
  async play() {
    if(this.state.role!=='host'||!this.fileMeta||this.state.loading)return;
    if(!this.signal.clock.synced)throw new Error('Wait for clock calibration before starting playback.');
    if(this.audio.playing)return;
    const session=this.session, selection=this.selection, transport=++this.transport;
    await this.enableAudio();
    if(session!==this.session || selection!==this.selection || transport!==this.transport || this.state.loading)return;
    this.audio.play(this.audio.position()>=this.audio.duration?0:null);
    this.revision++;this.publishTimeline();this.patch({playing:true,status:'Playing on the host-authoritative timeline.'});this.setMediaSession();
  }
  pause() {
    if(this.state.role!=='host')return;
    ++this.transport;
    this.audio.pause();this.revision++;this.publishTimeline();this.patch({playing:false,status:'Paused'});this.setMediaSession();
  }
  async seek(position) {
    if(this.state.role!=='host'||!this.fileMeta||this.state.loading)return;
    if(!Number.isFinite(position))return;
    this.audio.seek(position,this.audio.playing);this.revision++;this.publishTimeline();
  }
  publishTimeline() {
    if(this.state.role!=='host'||!this.signal?.clock.synced||!this.fileMeta||!this.epoch)return;
    this.signal.control({kind:'timeline',epoch:this.epoch,trackId:this.activeId,seq:++this.seq,revision:this.revision,
      playing:this.audio.playing,position:Math.min(this.audio.duration,this.audio.playing?this.audio.audiblePosition():this.audio.position()),
      atServerTime:this.signal.clock.now(),duration:this.audio.duration});
  }
  async adjacent(direction,ended=false) {
    if(this.state.role!=='host')return;
    const id=this.store.adjacent(direction,{shuffle:this.state.shuffle,repeat:this.state.repeat,ended});
    if(id)await this.loadTrack(id,ended||this.audio.playing);
    else {this.publishTimeline();this.patch({playing:false,status:'Queue finished'});}
  }
  async removeTrack(id) {
    if(this.state.role!=='host')return;
    if(id===this.activeId){const next=this.store.adjacent(1)||this.store.adjacent(-1);if(next&&next!==id)await this.loadTrack(next,this.audio.playing);else throw new Error('Add or select another track before removing the active track.');}
    this.store.remove(id);this.renderQueue();
  }
  renderQueue() {
    this.ui.renderQueue(this.store.items,this.activeId);
    this.patch({canPrevious:!!this.store.adjacent(-1,{repeat:this.state.repeat}),canNext:!!this.store.adjacent(1,{repeat:this.state.repeat})});
  }
  control(message) {
    if(this.state.role!=='guest'||message.from!==this.hostId)return;
    const data=message.data;if(data?.epoch!==this.epoch)return;
    if(data.kind==='track'&&validTrack(data)){
      const changed=this.activeId!==data.trackId;
      if(changed){this.audio.pause();this.sync.stop();this.activeId=data.trackId;}
      this.fileMeta=data;
      this.patch({track:{id:data.trackId,name:data.name,duration:data.duration},...(changed?{playing:false}:{}),status:this.cache.get(data.trackId)?'Audio ready':'Waiting for audio transfer…'});
      this.activateGuest(data.trackId);this.setMediaSession();
    }else if(data.kind==='timeline'&&validTimeline(data, null)){
      if(this.sync.setTimeline(data)){
        this.patch({status:data.playing?'Host is playing':'Host paused playback'});
        this.activateGuest(data.trackId);
      }
    }
  }
  async receiveFile({id,buffer,meta},session) {
    if(this.state.role!=='guest'||id!==this.hostId||meta.epoch!==this.epoch ||
       this.cache.get(meta.trackId) || this.pendingDecodeIds.has(meta.trackId))return;
    this.pendingDecodeIds.add(meta.trackId);
    const epoch=this.epoch;
    try{
      if(meta.trackId===this.activeId)this.patch({transfer:{progress:1,state:'decoding'},status:'Decoding received audio…'});
      const decoded=await this.decode(buffer);
      if(session!==this.session||epoch!==this.epoch||id!==this.hostId)return;
      this.cache.set(meta.trackId,decoded,this.activeId);
      if(meta.trackId===this.activeId){this.patch({transfer:null,status:'Audio decoded. Enable audio if needed.'});this.activateGuest(meta.trackId);}
    }catch(error){if(session===this.session)this.fail(error);}
    finally { this.pendingDecodeIds.delete(meta.trackId); }
  }
  activateGuest(id) {
    if(this.state.role!=='guest'||id!==this.activeId || !this.hostAvailable)return;
    const buffer=this.cache.get(id);if(!buffer)return;
    if(this.audio.buffer!==buffer){this.audio.setBuffer(buffer);this.sync.setActiveTrack(id);}
    if(this.audio.ctx?.state==='running'&&this.sync.timeline?.trackId===id){
      if(!this.sync.scheduler.running)this.sync.start();
      this.patch({audioEnabled:true,playing:this.audio.playing});
    }
  }
  async resync() {
    if(this.state.role!=='guest')return;
    await this.enableAudio();
    if(!this.cache.get(this.activeId)){this.signal.reconnect?.();this.ui.notify('Reconnecting to request the current audio again.');return;}
    this.sync.manualResync();this.ui.notify('Resynchronization requested; accuracy still depends on this device and network.');
  }
  renderDevices() {
    const devices=this.roster.filter(p=>p.id!==this.signal?.id).map(p=>{
      const peer=this.peers?.peers.get(p.id);
      return {id:p.id,name:p.name,role:p.role,state:peer?.pc?.connectionState|| (p.online===false?'disconnected':'connecting'),
        status: peer?.connected?'Connected':p.online===false?'Disconnected':'Connecting…',
        connection:peer?.connected?'connected':p.online===false?'disconnected':'connecting',quality:'Not measured',sync:'Not measured'};
    });
    this.ui.renderDevices(devices);
  }
  networkStatus() {
    const profile=this.quality.profile();const clock=this.signal?.clock.quality();
    this.patch({networkText:`${profile.mode} adaptation · Wi-Fi RSSI / band / channel unavailable${profile.hints.browserHints?` · ${profile.hints.effectiveType||'unknown'} browser estimate`:''}${profile.throughputBytesSec?` · delivery ${(profile.throughputBytesSec/1024).toFixed(0)} KiB/s`:''}`,
      ...(this.state.role==='host'?{syncText:clock?.synced?`Clock calibrated · midpoint uncertainty estimate ±${Math.round(clock.uncertaintyMs)} ms; not audio-output accuracy`:'Calibrating clock…'}:{})});
  }
  recordHistory(item) {
    try{const prior=JSON.parse(readPreference('history','[]'));savePreference('history',JSON.stringify([{name:item.name,playedAt:new Date().toISOString()},...(Array.isArray(prior)?prior:[]).filter(p=>p.name!==item.name)].slice(0,20)));}catch{/* Corrupt optional history is ignored, never audio state. */}
  }
  invite() {
    const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('room',this.state.code);url.searchParams.set('signal',this.state.signalUrl);return url.href;
  }
  async copyInvite(){await navigator.clipboard.writeText(this.invite());this.ui.notify('Room invitation link copied.');}
  async shareInvite(){if(navigator.share){try{await navigator.share({title:'WaveSync',text:`Join room ${this.state.code}`,url:this.invite()});}catch(error){if(error.name!=='AbortError')throw error;}}else await this.copyInvite();}
  setMediaSession() {
    if(!navigator.mediaSession)return;
    for(const action of mediaActions){try{navigator.mediaSession.setActionHandler(action,null);}catch{/* Unsupported media action. */}}
    if(this.state.track&&globalThis.MediaMetadata)navigator.mediaSession.metadata=new MediaMetadata({title:this.state.track.name,artist:'WaveSync',album:`Room ${this.state.code}`});
    else navigator.mediaSession.metadata=null;
    navigator.mediaSession.playbackState=this.audio.playing?'playing':'paused';
    if(this.state.role==='host'){
      const handlers={play:()=>this.play(),pause:()=>this.pause(),previoustrack:()=>this.adjacent(-1),nexttrack:()=>this.adjacent(1),seekto:event=>this.seek(event.seekTime)};
      for(const [action,fn]of Object.entries(handlers)){try{navigator.mediaSession.setActionHandler(action,event=>Promise.resolve(fn(event)).catch(error=>this.fail(error)));}catch{/* Unsupported browser action. */}}
    }
  }
  shortcut(event) {
    if(this.state.role!=='host'||event.target.closest('input,select,textarea,button,dialog')||event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.code==='Space'){event.preventDefault();(this.audio.playing?Promise.resolve(this.pause()):this.play()).catch(error=>this.fail(error));}
  }
  async registerPWA() {
    this.listen(window,'beforeinstallprompt',event=>{event.preventDefault();this.installPrompt=event;this.patch({installAvailable:true});});
    if(!('serviceWorker'in navigator))return;
    // Source-served dev worker has no content revision: do not install it over a live cache.
    if (['localhost','127.0.0.1','[::1]'].includes(location.hostname)) return;
    try{
      this.registration=await navigator.serviceWorker.register('./sw.js');
      const waiting=()=>{if(this.registration.waiting)this.patch({updateAvailable:true});};waiting();
      this.listen(this.registration,'updatefound',()=>{const worker=this.registration.installing;if(worker)this.listen(worker,'statechange',waiting);});
      this.listen(navigator.serviceWorker,'controllerchange',()=>{if(this.updating)location.reload();});
    }catch(error){this.ui.notify(`Offline installation unavailable: ${error.message}`);}
  }
  async install(){if(!this.installPrompt)return;await this.installPrompt.prompt();await this.installPrompt.userChoice;this.installPrompt=null;this.patch({installAvailable:false});}
  async update(){if(this.signal)throw new Error('Leave the room before installing the update to avoid interrupting audio.');if(this.registration?.waiting){this.updating=true;this.registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});}}
  leave() {
    ++this.session;++this.selection;++this.transport;this.hostAvailable=false;
    this.pendingDecodeIds.clear();this.decodeChain=Promise.resolve();
    clearInterval(this.heartbeat);clearInterval(this.uiTick);
    this.sessionListeners.splice(0).forEach(off=>off());
    this.sync?.destroy();this.peers?.destroy?.();this.peers?.closeAll();
    this.signal?.send({t:'leave'});this.signal?.close();
    this.audio.clear();this.audio.onEnded=null;this.cache.clear();this.store.clear();
    this.signal=this.peers=this.sync=null;this.epoch=this.activeId=this.hostId=null;
    this.fileBuffer=this.fileMeta=null;this.roster=[];this.seq=0;this.revision=0;
    this.ui.reset();this.patch({screen:'home',role:null,code:'',connection:'disconnected',track:null,playing:false,loading:false,transfer:null,status:'',syncText:'Not in a room',canPrevious:false,canNext:false});
    this.setMediaSession();
    const url=new URL(location.href);url.searchParams.delete('room');history.replaceState(null,'',url);
  }
  async destroy(){this.leave();this.listeners.splice(0).forEach(off=>off());this.quality.destroy();this.ui.destroy();await this.audio.dispose();}
}
if(typeof window!=='undefined')window.addEventListener('DOMContentLoaded',()=>{window.wavesync=new WaveSync();});

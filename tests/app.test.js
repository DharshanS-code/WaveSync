import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveSync } from '../src/app.js';
import { TrackStore,BufferCache } from '../src/track-store.js';
function app(){
  const value=Object.create(WaveSync.prototype);
  Object.assign(value,{session:1,selection:1,transport:0,state:{role:'host',loading:false},
    fileMeta:{trackId:'track-a'},activeId:'track-a',epoch:'epoch-a',hostId:'host-a',hostAvailable:true,
    pendingDecodeIds:new Set(),decodeChain:Promise.resolve(),cache:new BufferCache(),store:new TrackStore(),
    signal:{clock:{synced:true}},audio:{playing:false,duration:60,position:()=>0,play(){this.playing=true;},pause(){this.playing=false;}},
    ui:{notify(){}},patch(update){Object.assign(this.state,update);},publishTimeline(){},setMediaSession(){}});
  return value;
}
test('pending Play cannot override a newer Pause',async()=>{
  const value=app();let resumed;value.enableAudio=()=>new Promise(resolve=>resumed=resolve);
  const playing=value.play();value.pause();resumed();await playing;
  assert.equal(value.audio.playing,false);
});
test('pending Play cannot activate audio after selecting a different track',async()=>{
  const value=app();let resumed;value.enableAudio=()=>new Promise(resolve=>resumed=resolve);
  const playing=value.play();value.selection++;resumed();await playing;
  assert.equal(value.audio.playing,false);
});
test('decode serialization does not retain its successful AudioBuffer result',async()=>{
  const value=app();const buffer={duration:60};value.audio.decodeToBuffer=async()=>buffer;
  assert.equal(await value.decode(new ArrayBuffer(1)),buffer);
  assert.equal(await value.decodeChain,undefined);
});
test('host-unavailable guest cannot reactivate a cached playing timeline',()=>{
  const value=app();value.state.role='guest';value.hostAvailable=false;
  value.cache.set('track-a',{length:1,numberOfChannels:1});
  value.audio.setBuffer=()=>{throw new Error('Must not reactivate audio');};
  value.activateGuest('track-a');assert.equal(value.audio.playing,false);
});
test('duplicate delivered track is not decoded over the current buffer',async()=>{
  const value=app();value.state.role='guest';value.cache.set('track-a',{length:1,numberOfChannels:1});
  value.decode=()=>{throw new Error('Duplicate decode');};
  await value.receiveFile({id:'host-a',buffer:new ArrayBuffer(1),meta:{epoch:'epoch-a',trackId:'track-a'}},1);
  assert.equal(value.pendingDecodeIds.size,0);
});
test('failed replacement leaves active track in the queue',async()=>{
  const value=app();const [a]=value.store.append([{name:'A.wav',size:1,type:'audio/wav'},{name:'B.wav',size:1,type:'audio/wav'}]);
  value.activeId=a.id;value.store.currentId=a.id;value.loadTrack=async()=>{throw new Error('Unsupported audio');};
  await assert.rejects(value.removeTrack(a.id),/Unsupported/);
  assert.equal(value.store.get(a.id),a);
});

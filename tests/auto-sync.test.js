import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../src/sync-engine.js';
const config = { syncCheckMs: 100000, scheduleLeadSec: 0.02, maxLeadSec: 0.5 };
function engine() {
 const calls=[];
 const audio={ctx:{state:'running',currentTime:1},duration:60,playing:true,rate:1,
 hasAudio:()=>true,cancelCorrection:()=>calls.push('cancel'),hasCorrection:()=>false,
 pause(){this.playing=false;calls.push('pause');},seek:()=>calls.push('seek'),
 audiblePosition:()=>10,position:()=>10,outputMapping:()=>({contextTime:1,performanceTime:performance.now()}),
 getLatencyOffset:()=>0,setRate:()=>{},play(){this.playing=true;calls.push('play');},scheduleCorrection:()=>calls.push('correct')};
 const clock={synced:true,now:()=>10000,on:()=>()=>{}};
 const value=new SyncEngine(audio,clock,config); value.state='armed'; value.activeTrackId='track'; value.epoch='epoch';
 return {value,audio,calls};
}
function timeline(seq=1,playing=true){return {epoch:'epoch',trackId:'track',seq,revision:seq,playing,position:10,atServerTime:10000,duration:60};}
test('automatic synchronization can be disabled without restarting playback',()=>{
 const {value,calls}=engine();value.setAutomatic(false);calls.length=0;
 value.setTimeline(timeline());value._monitor();assert.deepEqual(calls,[]);assert.equal(value.scheduler.running,false);value.destroy();
});
test('host pause remains authoritative with automatic synchronization disabled',()=>{
 const {value,audio,calls}=engine();value.setAutomatic(false);calls.length=0;
 assert.equal(value.setTimeline(timeline(1,false)),true);assert.equal(audio.playing,false);assert.ok(calls.includes('pause'));value.destroy();
});
test('manual resync aligns once without enabling automatic correction',()=>{
 const {value,calls}=engine();value.setAutomatic(false);value.setTimeline(timeline());calls.length=0;
 value.manualResync();assert.ok(calls.includes('play'));assert.equal(value.automatic,false);assert.equal(value.scheduler.running,false);value.destroy();
});
test('reenabling automatic synchronization resumes monitor and expired sequence stays rejected',()=>{
 const {value,calls}=engine();value.setAutomatic(false);value.setTimeline(timeline());value.setAutomatic(true);
 assert.equal(value.scheduler.running,true);assert.ok(calls.includes('play'));assert.equal(value.setTimeline(timeline()),false);value.destroy();
});

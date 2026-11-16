import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockSynchronizer, DeadbeatController, AdaptiveResyncPolicy, SyncEngine } from '../src/sync-engine.js';
const cfg = {calibMinSamples: 5,clockWindow:30,maxRateAdjust:.02,convergeSec:1.2,holdToleranceSec:.006,hardThresholdSec:.25,syncCheckMs:250,scheduleLeadSec:.02,maxLeadSec:.5};

test('clock rejects invalid remote times rather than poisoning offset', () => {
  const clock = new ClockSynchronizer(cfg);
  clock.addSample(10, NaN, 20);
  assert.equal(clock.quality().samples, 0);
  assert.equal(clock.synced, false);
});
test('clock requires independent samples and reports quality before lock', () => {
  const clock = new ClockSynchronizer(cfg);
  let first;
  clock.on('sync', q => first = q);
  for (let i=0;i<4;i++) clock.addSample(i*100, 100000+i*100+5, i*100+10);
  assert.equal(clock.synced, false);
  clock.addSample(400,100405,410);
  assert.equal(clock.synced, true);
  assert.equal(first.samples,5);
  assert.equal(first.rtt,10);
});
test('shared clock uses the injected monotonic source not Date.now changes', () => {
  let mono=0;
  const clock=new ClockSynchronizer({...cfg,now:()=>mono});
  for(let i=0;i<5;i++) {mono=i*100+10;clock.addSample(i*100,50000+i*100+5,mono);}
  const before=clock.now();mono+=1000;
  assert.ok(Math.abs(clock.now()-before-1000)<1e-6);
});
test('deadbeat sign and duration converge with capped rate', () => {
  const controller=new DeadbeatController(cfg);
  for(const error of [-.2,-.03,.03,.2]){
    const p=controller.plan(error);
    assert.ok(Math.abs(p.u)<=.02);
    assert.ok(Math.abs(error+p.u*p.dur)<1e-9);
  }
  assert.equal(controller.plan(.004).type,'hold');
});
test('healthy readings clear hard-resync streak', () => {
  const policy=new AdaptiveResyncPolicy(cfg);
  assert.equal(policy.shouldReseek(.3),false);
  policy.shouldReseek(.001);
  assert.equal(policy.shouldReseek(.3),false);
});
const timeline=(seq=1)=>({kind:'timeline',epoch:'room-a',trackId:'track-a',seq,revision:1,playing:false,position:0,atServerTime:100000,duration:60});
function engine(){
  const audio={ctx:{state:'running',currentTime:1},playing:false,hasAudio:()=>true,duration:60,addLifecycleListener:()=>()=>{},cancelCorrection(){},pause(){},seek(){},hasCorrection:()=>false};
  const clock=new ClockSynchronizer(cfg);clock.synced=true;clock.now=()=>100000;
  return new SyncEngine(audio,clock,cfg);
}
test('timeline rejects equal/lower sequence numbers and invalid values', () => {
  const sync=engine();
  assert.equal(sync.setTimeline(timeline()),true);
  assert.equal(sync.setTimeline(timeline()),false);
  assert.equal(sync.setTimeline({...timeline(2),position:NaN}),false);
  assert.equal(sync.setTimeline({...timeline(2),seq:'2'}),false);
  sync.destroy();
});
test('inactive or mismatched-track engine does not align new timelines', () => {
  const sync=engine();let seeks=0;sync.audio.seek=()=>seeks++;
  sync.setTimeline(timeline());assert.equal(seeks,0);
  sync.setActiveTrack('other');sync.start();assert.equal(seeks,0);
  sync.destroy();
});

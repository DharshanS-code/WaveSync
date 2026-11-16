import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkQuality } from '../src/network-quality.js';

test('unsupported browsers report unknown hardware and conservative fallback facts',()=>{
  const q=new NetworkQuality({});
  assert.equal(q.capabilities().rssiDbm,null);
  assert.equal(q.capabilities().band,null);
  assert.equal(q.profile().mode,'unmeasured');
  assert.equal(q.profile().throughputBytesSec,null);
  q.destroy();
});
test('browser estimates never become hardware measurements',()=>{
  const q=new NetworkQuality({connection:{effectiveType:'4g',downlink:10,saveData:false}});
  assert.equal(q.capabilities().downlinkMbps,10);
  assert.equal(q.capabilities().linkSpeedMbps,null);
  assert.equal(q.profile().mode,'unmeasured');
});
test('delivery stalls and interruption select bounded conservative buffering',()=>{
  const q=new NetworkQuality({});
  q.delivery({bytes:65536,durationMs:2000,stalledMs:1000});
  assert.equal(q.profile().mode,'conservative');
  assert.equal(q.profile().maxBufferedBytes,262144);
  assert.ok(q.profile().safetyMarginSec<=.25);
});
test('stable mode needs repeated actual delivery and matched peer telemetry',()=>{
  const q=new NetworkQuality({});
  for(let i=0;i<3;i++)q.delivery({bytes:1024*1024,durationMs:1000});
  assert.equal(q.profile().mode,'unmeasured');
  q.peerSample({rtt:8,jitter:2,loss:0});
  assert.equal(q.profile().mode,'stable');
});
test('data saving suppresses optional next track prefetch',()=>{
  const q=new NetworkQuality({connection:{saveData:true}});
  assert.equal(q.profile().prefetchNext,false);
  assert.equal(q.profile().mode,'conservative');
});

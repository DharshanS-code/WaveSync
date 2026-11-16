import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackStore,BufferCache } from '../src/track-store.js';
const file=name=>({name,size:100,type:'audio/wav'});
test('queue appends stable identities and normalizes wire metadata',()=>{
  const s=new TrackStore();const [a,b]=s.append([file('a'.repeat(220)+'.wav'),file('.mp3')]);
  assert.equal(a.name.length,200);assert.equal(b.name,'Untitled track');assert.notEqual(a.id,b.id);
  const [c]=s.append([file('third.wav')]);assert.equal(s.items.length,3);assert.equal(s.get(c.id),c);
});
test('reordering preserves current track identity and supports previous/next',()=>{
  const s=new TrackStore();const [a,b,c]=s.append(['a','b','c'].map(file));s.currentId=b.id;
  s.move(b.id,'up');assert.equal(s.items[0].id,b.id);assert.equal(s.currentId,b.id);
  assert.equal(s.adjacent(1),a.id);s.move(b.id,c.id,true);assert.equal(s.items[2].id,b.id);
});
test('repeat one applies only at natural end and repeat all wraps',()=>{
  const s=new TrackStore();const [a,b]=s.append(['a','b'].map(file));s.currentId=b.id;
  assert.equal(s.adjacent(1),null);assert.equal(s.adjacent(1,{repeat:'all'}),a.id);
  assert.equal(s.adjacent(1,{repeat:'one',ended:true}),b.id);
});
test('cache keeps at most two buffers and counts decoded bytes',()=>{
  const c=new BufferCache(100);const b={length:10,numberOfChannels:1};
  c.set('a',b);c.set('b',b,'a');c.set('c',b,'a');assert.equal(c.buffers.size,2);assert.equal(c.get('b'),undefined);
  c.clear();assert.equal(c.bytes,0);
});

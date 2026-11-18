import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../sw.js',import.meta.url),'utf8');
function setup({rejectInstall=false}={}){
  const events={};const removed=[];let skipped=0;let claimed=0;
  const scope='https://example.com/music/';
  const context={URL,Set,encodeURIComponent,console,
    self:{registration:{scope},location:{origin:'https://example.com'},clients:{claim:async()=>claimed++},
      skipWaiting:async()=>skipped++,addEventListener:(type,fn)=>events[type]=fn},
    caches:{open:async()=>({addAll:async()=>{if(rejectInstall)throw new Error('missing shell');},match:async()=>new Response('cached shell')}),
      keys:async()=>['other-app','wavesync-'+encodeURIComponent(scope)+'-old','wavesync-other-scope-old'],delete:async key=>removed.push(key)},
    fetch:async()=>new Response('network')};
  vm.runInNewContext(source,context);
  return {events,removed,get skipped(){return skipped;},get claimed(){return claimed;}};
}
test('failed complete-shell install rejects and never skips waiting',async()=>{
  const s=setup({rejectInstall:true});let work;s.events.install({waitUntil:p=>work=p});
  await assert.rejects(work,/missing shell/);assert.equal(s.skipped,0);
});
test('update activation is explicit and scope cleanup preserves unrelated apps',async()=>{
  const s=setup();let work;s.events.install({waitUntil:p=>work=p});await work;assert.equal(s.skipped,0);
  s.events.message({data:{type:'ACTIVATE_UPDATE'},waitUntil:p=>work=p});await work;assert.equal(s.skipped,1);
  s.events.activate({waitUntil:p=>work=p});await work;assert.equal(s.removed.length,1);assert.equal(s.claimed,1);
});
test('offline invitation navigation uses cached canonical shell',async()=>{
  const s=setup();let response;s.events.fetch({request:{url:'https://example.com/music/?room=ABCDEF',method:'GET',mode:'navigate'},respondWith:p=>response=p});
  assert.equal(await(await response).text(),'cached shell');
});
test('runtime feature configuration is never cached or intercepted',()=>{
  const s=setup();let called=false;
  s.events.fetch({request:{url:'https://example.com/music/config/features.json',method:'GET',mode:'cors'},respondWith:()=>called=true});
  assert.equal(called,false);
});
test('API and cross-origin fetches are never cached or intercepted',()=>{
  const s=setup();let called=false;
  for(const url of ['https://example.com/api/room','https://third-party.test/data'])s.events.fetch({request:{url,method:'GET'},respondWith:()=>called=true});
  assert.equal(called,false);
});

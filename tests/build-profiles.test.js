import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile } from '../scripts/build.mjs';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
async function tree(directory){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())result.push(...await tree(path));else result.push(path);}return result;}
async function isolated(fn){await mkdir(resolve(root,'test-results'),{recursive:true});const output=await mkdtemp(resolve(root,'test-results/build-profiles-'));try{await fn(output);}finally{await rm(output,{recursive:true,force:true});}}
test('self-hosted output omits official endpoints and complete donation implementation',async()=>isolated(async output=>{
 const report=await buildProfile({profile:'self-hosted',output});assert.equal(report.profile,'self-hosted');
 for(const file of await tree(output)){
  if(!/\.(?:html|css|js|json|svg)$/.test(file))continue;
  const text=await readFile(file,'utf8');
  assert.doesNotMatch(text,/wavesync-signal\.dharshandcu|dharshandcu@nyes|upi:\/\/|supportCreator|support-screen|data-donation|instagram\.com\/dharshandcu/);
 }
 const config=await readFile(resolve(output,'src/deployment.js'),'utf8');assert.match(config,/"signalUrl":""/);
 assert.match(await readFile(resolve(output,'index.html'),'utf8'),/signaling-setup/);
 const sw=await readFile(resolve(output,'sw.js'),'utf8');assert.doesNotMatch(sw,/official\//);
}));
test('official output retains isolated endpoint and fail-closed support configuration',async()=>isolated(async output=>{
 const report=await buildProfile({profile:'official',output});assert.equal(report.profile,'official');
 assert.match(await readFile(resolve(output,'src/deployment.js'),'utf8'),/wavesync-signal\.dharshandcu/);
 assert.match(await readFile(resolve(output,'index.html'),'utf8'),/support-screen/);
 assert.equal(JSON.parse(await readFile(resolve(output,'config/features.json'),'utf8')).supportCreator,true);
}));
test('reusing an owned output removes stale official files and changes profile revision',async()=>isolated(async output=>{
 const first=await buildProfile({profile:'official',output});const second=await buildProfile({profile:'self-hosted',output});
 assert.notEqual(first.revision,second.revision);
 const names=await tree(output);assert.equal(names.some(file=>file.includes('/official/')),false);
 assert.equal(names.some(file=>file.endsWith('/config/features.json')),false);
}));
test('build rejects unexpected files rather than deleting unrelated data',async()=>isolated(async output=>{
 await writeFile(resolve(output,'keep.txt'),'user data');await assert.rejects(buildProfile({profile:'self-hosted',output}),/unexpected|unowned/i);
 assert.equal(await readFile(resolve(output,'keep.txt'),'utf8'),'user data');
}));
test('custom operator endpoint is validated and no endpoint still builds',async()=>isolated(async output=>{
 await assert.rejects(buildProfile({profile:'self-hosted',output,deployment:{signalUrl:'ws://public.example/api'}}),/wss|WebSocket/i);
 await buildProfile({profile:'self-hosted',output,deployment:{signalUrl:'wss://operator.example/api',operator:'Independent',providerNote:'Operator hosted'}});
 assert.match(await readFile(resolve(output,'src/deployment.js'),'utf8'),/wss:\/\/operator\.example/);
}));

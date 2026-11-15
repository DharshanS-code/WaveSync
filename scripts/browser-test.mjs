// Termux Node reports android inside Debian PRoot; the installed browser is Linux Chromium.
// Restrict this compatibility override to the test driver, never application capabilities.
if (process.platform === 'android' && process.env.WAVESYNC_PROOT_BROWSER === '1') {
  Object.defineProperty(process, 'platform', { value: 'linux' });
}
const { chromium } = await import('playwright');
import { createStaticServer } from './dev.mjs';
import { createDevServer } from '../backend/dev-server.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evidence=resolve(root,'test-results');await mkdir(evidence,{recursive:true});
const web=createStaticServer({port:0}),signal=createDevServer({port:0});
await Promise.all([web,signal].map(server=>server.listening?Promise.resolve():new Promise(resolve=>server.once('listening',resolve))));
const base=`http://127.0.0.1:${web.address().port}/?signal=${encodeURIComponent(`ws://127.0.0.1:${signal.address().port}/api/room`)}`;
let browser;const errors=[];const checks=[];
function wav(seconds=8,frequency=440){
  const rate=8000,frames=rate*seconds;const bytes=Buffer.alloc(44+frames*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
  for(let i=0;i<frames;i++)bytes.writeInt16LE(Math.round(Math.sin(i/rate*Math.PI*2*frequency)*6000),44+i*2);
  return bytes;
}
try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
  const hostContext=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  const guestContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const host=await hostContext.newPage(),guest=await guestContext.newPage();
  for(const page of [host,guest])page.on('pageerror',error=>errors.push(error.message));
  await host.goto(base);await host.waitForFunction(()=>!!window.wavesync);
  await host.screenshot({path:resolve(evidence,'home-1440x900.png'),fullPage:true});
  await host.locator('#support-fab').click();
  assert.equal(await host.locator('#support-overlay').isVisible(),true);
  await host.keyboard.press('Escape');
  assert.equal(await host.locator('#support-overlay').isVisible(),false);
  checks.push('Support dialog opens and Escape closes without trapped focus');
  await host.locator('#home-settings > summary').click();
  await host.locator('#theme-select').selectOption('dark');
  await host.screenshot({path:resolve(evidence,'dark-1440x900.png'),fullPage:true});
  await host.locator('#theme-select').selectOption('light');
  await guest.goto(base);await guest.waitForFunction(()=>!!window.wavesync);
  await guest.screenshot({path:resolve(evidence,'home-390x844.png'),fullPage:true});
  await host.locator('#display-name').fill('Desktop host');await host.locator('#create-room').click();
  await host.waitForFunction(()=>window.wavesync.epoch&&window.wavesync.signal.clock.synced,null,{timeout:20000});
  const code=await host.evaluate(()=>window.wavesync.state.code);
  await guest.locator('#display-name').fill('Phone guest');await guest.locator('#join-code').fill(code);await guest.locator('#join-room').click();
  await guest.waitForFunction(()=>window.wavesync.epoch&&window.wavesync.signal.clock.synced,null,{timeout:20000});
  await guest.evaluate(()=>window.wavesync.audio.ctx.suspend());
  await guest.waitForFunction(()=>window.wavesync.state.audioEnabled===false);
  assert.equal(await guest.locator('#audio-permission').isVisible(),true);
  await guest.screenshot({path:resolve(evidence,'permission-390x844.png'),fullPage:true});
  await guest.locator('#enable-audio').click();
  await guest.waitForFunction(()=>window.wavesync.audio.ctx.state==='running');
  checks.push('Real AudioContext suspension exposes enable-audio permission/recovery action');
  await host.locator('#audio-files').setInputFiles([{name:'Test tone A.wav',mimeType:'audio/wav',buffer:wav(20)},
    {name:'Test tone B.wav',mimeType:'audio/wav',buffer:wav(20,660)}]);
  await host.waitForFunction(()=>window.wavesync.activeId&&!window.wavesync.state.loading);
  await guest.waitForFunction(()=>window.wavesync.cache.get(window.wavesync.activeId),null,{timeout:30000});
  checks.push('Real WebSocket room create/join and WebRTC DataChannel WAV transfer/decode');
  await host.locator('#play-toggle').click();
  await guest.waitForFunction(()=>window.wavesync.audio.playing,null,{timeout:15000});
  const playback=await Promise.all([host,guest].map(page=>page.evaluate(()=>({playing:window.wavesync.audio.playing,position:window.wavesync.audio.position(),trackId:window.wavesync.activeId}))));
  assert.equal(playback[0].trackId,playback[1].trackId);assert.ok(playback.every(p=>p.playing));
  checks.push('Host/guest actual AudioBufferSource playback; no acoustic accuracy claim');
  await host.screenshot({path:resolve(evidence,'host-1440x900.png'),fullPage:true});
  await guest.screenshot({path:resolve(evidence,'guest-390x844.png'),fullPage:true});
  assert.equal(await guest.locator('[data-host-only]:visible').count(),0);
  for(const page of [host,guest])assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  checks.push('Guest role separation and no horizontal overflow at target viewports');
  await host.locator('#play-toggle').click();await guest.waitForFunction(()=>!window.wavesync.audio.playing);
  checks.push('Authoritative pause reaches guest');
  await host.locator('#next-track').click();await host.waitForFunction(id=>window.wavesync.activeId!==id,playback[0].trackId);
  await guest.waitForFunction(()=>window.wavesync.activeId===window.wavesync.fileMeta?.trackId&&window.wavesync.cache.get(window.wavesync.activeId));
  await host.locator('#play-toggle').click();await guest.waitForFunction(()=>window.wavesync.audio.playing);
  checks.push('Playlist transition by stable track identity');
  await guest.evaluate(()=>window.wavesync.signal.reconnect());
  await guest.waitForFunction(()=>window.wavesync.signal.registered&&[...window.wavesync.peers.peers.values()].some(p=>p.dc?.readyState==='open'),null,{timeout:25000});
  checks.push('Guest signaling reconnect rebuilds direct data channel');
  await host.evaluate(()=>window.wavesync.leave());
  await guest.waitForFunction(()=>!window.wavesync.hostAvailable);
  await guest.waitForFunction(()=>window.wavesync.signal.clock.quality().samples>=6,null,{timeout:10000});
  assert.equal(await guest.evaluate(()=>window.wavesync.audio.playing),false);
  checks.push('Host departure cannot restart guest via clock updates');
  await guest.evaluate(()=>window.wavesync.leave());
  await guest.locator('#home-settings > summary').click();
  await guest.locator('#theme-select').selectOption('dark');
  await guest.screenshot({path:resolve(evidence,'dark-390x844.png'),fullPage:true});
  await guest.locator('#join-code').fill('AAAAAA');
  await guest.locator('#join-room').click();
  await guest.waitForFunction(()=>window.wavesync.state.screen==='home'&&!!window.wavesync.state.homeError);
  await guest.screenshot({path:resolve(evidence,'error-390x844.png'),fullPage:true});
  checks.push('Nonexistent room produces actual backend error and deterministic home teardown');
  await guest.setViewportSize({width:320,height:844});
  assert.equal(await guest.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  checks.push('Theme switching and 320px reflow');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(evidence,'browser-report.json'),JSON.stringify({status:'pass',checks,playback,errors,
    limitations:['Chromium on one machine, not independent physical audio outputs','No acoustic divergence, Android/iOS, Bluetooth or real Wi-Fi-band validation','Service worker tested separately in unit suite']},null,2));
  console.log(JSON.stringify({status:'pass',checks,playback,errors},null,2));
}catch(error){await writeFile(resolve(evidence,'browser-report.json'),JSON.stringify({status:'fail',checks,errors,error:error.stack},null,2));throw error;}
finally{await browser?.close();await Promise.all([web,signal].map(server=>new Promise(resolve=>server.close(resolve))));}

import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsController } from '../src/settings-controller.js';
function setup() {
 const values=new Map();
 const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),key:index=>[...values.keys()][index],get length(){return values.size;}}});
 const events=[];
 const app={audio:{volume:1,setVolume(v){this.volume=v;},setChannelMode(v){events.push(['channel',v]);}},sync:{setAutomatic(v){events.push(['sync',v]);}},state:{role:'host'},patch(){},ui:{notify(message){events.push(['notice',message]);},confirm:async()=>true}};
 const settings=new SettingsController(app);settings.diagnostics=()=>{};
 return {settings,app,events,values,restore(){if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;}};
}
test('configured default volume is independent from remembered local volume',async()=>{
 const s=setup();try {
  await s.settings.change('defaultVolume',0.4);s.settings.setVolume(0.2);
  await s.settings.change('channelEnabled',true);await s.settings.change('channelMode','left');
  assert.equal(s.app.audio.volume,0.2);assert.equal(s.values.get('wavesync.volume'),'0.2');
  await s.settings.change('rememberVolume',false);assert.equal(s.app.audio.volume,0.4);assert.equal(s.values.has('wavesync.volume'),false);
  await s.settings.change('defaultVolume',0.35);assert.equal(s.app.audio.volume,0.35);
 }finally{s.restore();}
});
test('notification toggles persist independently without changing unrelated groups',async()=>{
 const s=setup();try{
  await s.settings.change('notifyPlayback',false);
  assert.deepEqual(s.settings.preferences.notifications,{room:true,playback:false,transfer:true,reconnect:true});
  assert.deepEqual(JSON.parse(s.values.get('wavesync.settings')).notifications,s.settings.preferences.notifications);
  s.settings.event('playback','suppressed');assert.equal(s.events.some(e=>e[1]==='suppressed'),false);
 }finally{s.restore();}
});
test('a late notification permission result cannot undo turning notifications off',async()=>{
 const s=setup(), descriptor=Object.getOwnPropertyDescriptor(globalThis,'Notification');let grant;
 Object.defineProperty(globalThis,'Notification',{configurable:true,value:{permission:'default',requestPermission:()=>new Promise(resolve=>{grant=resolve;})}});
 try{
  const pending=s.settings.change('browserNotifications',true);
  await s.settings.change('browserNotifications',false);grant('granted');await pending;
  assert.equal(s.settings.preferences.browserNotifications,false);
  assert.equal(JSON.parse(s.values.get('wavesync.settings')).browserNotifications,false);
 }finally{if(descriptor)Object.defineProperty(globalThis,'Notification',descriptor);else delete globalThis.Notification;s.restore();}
});
test('confirmed reset invalidates pending browser notification permission',async()=>{
 const s=setup(), descriptor=Object.getOwnPropertyDescriptor(globalThis,'Notification');let grant;
 Object.defineProperty(globalThis,'Notification',{configurable:true,value:{permission:'default',requestPermission:()=>new Promise(resolve=>{grant=resolve;})}});
 try{
  const pending=s.settings.change('browserNotifications',true);await s.settings.reset();grant('granted');await pending;
  assert.equal(s.settings.preferences.browserNotifications,false);assert.equal(s.values.has('wavesync.settings'),false);
 }finally{if(descriptor)Object.defineProperty(globalThis,'Notification',descriptor);else delete globalThis.Notification;s.restore();}
});
test('background event uses service-worker browser notification when supported',async()=>{
 const s=setup(), doc=Object.getOwnPropertyDescriptor(globalThis,'document'), notification=Object.getOwnPropertyDescriptor(globalThis,'Notification');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'hidden'}});
 Object.defineProperty(globalThis,'Notification',{configurable:true,value:{permission:'granted'}});
 try{
  let captured;s.app.registration={showNotification:async(title,options)=>{captured={title,options};}};
  s.settings.preferences.browserNotifications=true;s.settings.event('room','Joined');await Promise.resolve();
  assert.deepEqual(captured,{title:'WaveSync',options:{body:'Joined',tag:'wavesync-room'}});
 }finally{if(doc)Object.defineProperty(globalThis,'document',doc);else delete globalThis.document;if(notification)Object.defineProperty(globalThis,'Notification',notification);else delete globalThis.Notification;s.restore();}
});
test('confirmed reset preserves room identity and does not persist deleted preferences again',async()=>{
 const s=setup();try{
  s.values.set('wavesync.history','[]');s.values.set('wavesync.name','host');s.values.set('unrelated','keep');
  await s.settings.change('channelEnabled',true);await s.settings.reset();
  assert.equal(s.app.state.role,'host');assert.equal(s.settings.preferences.channelEnabled,false);
  assert.equal(s.values.has('wavesync.settings'),false);assert.equal(s.values.get('wavesync.name'),'host');
  await s.settings.reset(true);assert.deepEqual([...s.values.keys()],['unrelated']);
 }finally{s.restore();}
});

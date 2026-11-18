import test from 'node:test';
import assert from 'node:assert/strict';
import { UI } from '../src/ui.js';
function ui() {
 const controls=new Map(['create-room','join-room'].map(id=>[id,{disabled:false}]));
 const value=Object.create(UI.prototype);value.el=Object.fromEntries(controls);value.last={};
 value.root={querySelectorAll:()=>[],getElementById:()=>null};
 value._text=()=>{};value._showScreen=()=>{};value.navigate=()=>{};value._applyPreference=()=>{};
 return {value,controls};
}
test('online transition never enables Create/Join during an active room',()=>{
 const {value,controls}=ui();value.render({role:'host',online:false,screen:'room'});value.render({online:true});
 assert.equal(controls.get('create-room').disabled,true);assert.equal(controls.get('join-room').disabled,true);
 value.render({role:null,screen:'home'});assert.equal(controls.get('create-room').disabled,false);
});
test('focus trap wraps forward and reverse among visible controls',()=>{
 const {value}=ui();let focused;
 const first={getClientRects:()=>[{}],closest:()=>null,focus:()=>{focused='first';}};
 const last={getClientRects:()=>[{}],closest:()=>null,focus:()=>{focused='last';}};
 const hidden={getClientRects:()=>[],closest:()=>null};
 const container={querySelectorAll:()=>[first,hidden,last]};
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{activeElement:last}});
 try{
  let prevented=false;value._trapFocus({shiftKey:false,preventDefault(){prevented=true;}},container);
  assert.equal(focused,'first');assert.equal(prevented,true);
  document.activeElement=first;value._trapFocus({shiftKey:true,preventDefault(){}},container);assert.equal(focused,'last');
 }finally{if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else delete globalThis.document;}
});
test('notification checkboxes display their nested persisted values',()=>{
 const {value}=ui();const room={dataset:{setting:'notifyRoom'},type:'checkbox'},playback={dataset:{setting:'notifyPlayback'},type:'checkbox'};
 value.root.querySelectorAll=()=>[room,playback];
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{dataset:{}}}});
 try{value.renderSettings({notifications:{room:true,playback:false},defaultVolume:1});assert.equal(room.checked,true);assert.equal(playback.checked,false);}
 finally{if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;}
});

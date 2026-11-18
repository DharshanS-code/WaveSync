import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSignalUrl } from '../src/config.js';
const publicPage={hostname:'independent.example',protocol:'https:',search:'?signal=wss://untrusted.example/api'};
test('self-hosted deployment has no public signaling fallback',()=>{
 assert.equal(resolveSignalUrl(publicPage,{profile:'self-hosted',signalUrl:''}),'');
});
test('public deployment uses only its validated configured endpoint',()=>{
 assert.equal(resolveSignalUrl(publicPage,{profile:'self-hosted',signalUrl:'wss://operator.example/api/room'}),'wss://operator.example/api/room');
 assert.equal(resolveSignalUrl(publicPage,{profile:'official',signalUrl:'wss://maintained.example/api/room'}),'wss://maintained.example/api/room');
});
test('invalid public configuration cannot become a signaling endpoint',()=>{
 for(const signalUrl of ['https://operator.example','ws://operator.example','wss://user:pass@operator.example','wss://operator.example/#token']){
  assert.equal(resolveSignalUrl(publicPage,{profile:'self-hosted',signalUrl}),'');
 }
});

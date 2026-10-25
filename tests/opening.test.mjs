// Cancellation and transfer boundaries without a browser or a Codex session.
// Real decode, replay, keyboard and animation lifecycle: opening.browser.mjs.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {prepareOpening as prepareMedia, removeNativeUi} from '../engine/renderer.mjs';
import {prepareOpening, showOpening, releaseOpening} from '../engine/opening-client.mjs';
import {applyTargets} from '../engine/target-runner.mjs';

class Media extends EventTarget {
 constructor(){super();this.style={};this.dataset={};this.readyState=0;this.currentTime=0;this.paused=true;}
 append(child){child.parent=this;}setAttribute(){}remove(){}pause(){this.paused=true;}load(){}
 removeAttribute(name){if(name==='src')this.src='';}
}
let revoked=[];
globalThis.window={};globalThis.document={documentElement:new Media(),createElement:()=>new Media()};
globalThis.matchMedia=()=>({matches:false});
URL.createObjectURL=()=>`blob:test-${revoked.length}`;URL.revokeObjectURL=url=>revoked.push(url);
const assets={video:'data:video/mp4;base64,eA=='};
const began=performance.now();
const preparing=prepareMedia(assets,'cancel');
assert.ok(window.__SANDRONE_MEDIA_CACHE__?.color,'preparation has started');
const color=window.__SANDRONE_MEDIA_CACHE__.color;
removeNativeUi();
assert.deepEqual(await preparing,{prepared:false,reason:'cancelled'});
assert.ok(performance.now()-began<1000,'disable settles readiness instead of waiting for the media deadline');
assert.equal(window.__SANDRONE_MEDIA_CACHE__,undefined);assert.equal(color.src,'');assert.equal(revoked.length,1);
removeNativeUi();assert.equal(revoked.length,1,'release is idempotent');

// Exercise actual serialized transfer guards in a renderer-like JS context.
// Delete the input halfway through the first large payload: no later chunk or
// player initialization may resurrect the cancelled preparation.
const context=vm.createContext({window:{},matchMedia:()=>({matches:false})});
const large={video:'data:video/mp4;base64,'+'A'.repeat(700000)};
let cancelled=false,largest=0;
const evaluate=async expression=>{
 largest=Math.max(largest,expression.length);
 const result=await vm.runInContext(expression,context);
 if(!cancelled&&expression.includes('.push(')){cancelled=true;await releaseOpening(evaluate);}
 return result;
};
assert.deepEqual(await prepareOpening(evaluate,large),{prepared:false,reason:'cancelled'});
assert.equal(context.window.__SANDRONE_OPENING_INPUT__,undefined);
assert.equal(context.window.__SANDRONE_PLAYER__,undefined);
assert.ok(largest<270000,'media is transferred in bounded chunks');

// Also restore between reading the renderer epoch and installing the input.
const earlyContext=vm.createContext({window:{},matchMedia:()=>({matches:false})});let early=false;
const earlyEvaluate=async expression=>{
 const result=await vm.runInContext(expression,earlyContext);
 if(!early&&expression.startsWith('({epoch:')){early=true;await releaseOpening(earlyEvaluate);}
 return result;
};
assert.deepEqual(await prepareOpening(earlyEvaluate,large),{prepared:false,reason:'cancelled'});
assert.equal(earlyContext.window.__SANDRONE_OPENING_INPUT__,undefined);

// Exercise the real startup coordinator and client together: restoring during
// preload, or after preload while verification is pending, must not reprepare.
for (const afterReady of [false,true]) {
 globalThis.window={};let transfers=0,openingCalls=0,shown;
 const startupAssets=afterReady?{}:{video:'data:video/mp4;base64,eA=='};
 const evaluate=async expression=>{
  if(expression.includes('window.__SANDRONE_OPENING_INPUT__={token:')){
   transfers++;
   assert.equal(transfers,1,'restoring during startup must not initiate another media transfer');
  }
  return (0,eval)(expression);
 };
 const session={close(){},evaluate:async expression=>{
  if(expression.startsWith('Boolean(document.visibility')||expression.includes('__CODEX_DREAM_SKIN_STATE__')||expression.startsWith('window.__SANDRONE_NATIVE_UI__')||expression.includes('function setStartupPhase'))return true;
  return evaluate(expression);
 }};
 await applyTargets({pages:[{id:'startup'}],connect:async()=>session,
  resources:async()=>({loaded:{revision:'test',theme:{id:'sandrone'}},css:''}),
  prepareOpening:()=>prepareOpening(evaluate,startupAssets),
  opening:async(_session,prepared)=>{openingCalls++;shown=await showOpening(evaluate,startupAssets,{},prepared);},
  verify:async()=>{
   while(!window.__SANDRONE_MEDIA_CACHE__)await new Promise(resolve=>setTimeout(resolve,1));
   if(afterReady)await window.__SANDRONE_MEDIA_CACHE__.ready;
   removeNativeUi();return {pass:true};
  }});
 assert.equal(transfers,1);assert.equal(window.__SANDRONE_MEDIA_CACHE__,undefined);
 if(afterReady)assert.deepEqual(shown,{shown:false,reason:'cancelled'});
 else assert.equal(openingCalls,0,'a cancelled preparation must not enter playback');
}

// Even a newly enabled cache must not make an older display request valid.
globalThis.window={};
const directEvaluate=async expression=>(0,eval)(expression);
const oldPreparation=await prepareOpening(directEvaluate,{});
await releaseOpening(directEvaluate);
await prepareOpening(directEvaluate,{});
assert.deepEqual(await showOpening(directEvaluate,{}, {},oldPreparation),{shown:false,reason:'cancelled'});
await releaseOpening(directEvaluate);
console.log('PASS: bounded transfer, startup cancellation during/after preparation, stale display rejection, media-ready cancellation and idempotent release');

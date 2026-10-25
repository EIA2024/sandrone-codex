// Cancellation and transfer boundaries without a browser or a Codex session.
// Real decode, replay, keyboard and animation lifecycle: opening.browser.mjs.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {prepareOpening as prepareMedia, removeNativeUi} from '../engine/renderer.mjs';
import {prepareOpening, releaseOpening} from '../engine/opening-client.mjs';

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
console.log('PASS: bounded transfer, cancellation before/during transfer, media-ready cancellation and idempotent release');

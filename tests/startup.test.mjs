import assert from 'node:assert/strict';
import vm from 'node:vm';
import {applyTargets,transient} from '../engine/target-runner.mjs';
import {protocolFailure,Session} from '../engine/cdp.mjs';
import {inspectTargetWindow} from '../vendor/dream-skin/windows/scripts/injector.mjs';
const unsupported=await inspectTargetWindow({send:async()=>{throw protocolFailure({code:-32000,message:'Browser window not found'});}},'test-target');
assert.equal(unsupported.unsupported,true,'preserve protocol codes for upstream native-window fallback');
let closed=0,verified=0,resourcesRead=0;
const pages=[{id:'hidden'},{id:'active'}];
const resources=async()=>{resourcesRead++;return {loaded:{payload:'fixed-theme',revision:'test',theme:{id:'sandrone'}},css:'fixed-css'};};
const connect=async page=>({evaluate:async expression=>expression.startsWith('Boolean(document.visibility')?page.id==='active':true,close(){closed++;}});
let result=await applyTargets({pages,connect,resources,verify:async()=>{verified++;return {pass:true};}});
assert.equal(result.ready,true);assert.equal(verified,1);assert.equal(resourcesRead,1,'hidden page must not load payload');assert.equal(closed,2);
result=await applyTargets({pages,connect:async p=>{if(p.id==='hidden')throw Object.assign(new Error('reload'),{code:'CDP_CLOSED'});return connect(p);},resources,verify:async()=>({pass:true})});
assert.equal(result.ready,true,'one reloading page cannot fail the healthy main window');
result=await applyTargets({pages:[{id:'active'}],connect:async()=>{throw Object.assign(new Error('context replaced'),{code:'CDP_CONTEXT'});},resources});
assert.equal(result.ready,false);assert.equal(transient({code:'CDP_CONTEXT'}),true);
result=await applyTargets({pages:[{id:'active'}],connect,resources,verify:async()=>({pass:true})});assert.equal(result.ready,true,'next poll recovers after reload');
await assert.rejects(applyTargets({pages,connect:async()=>{throw Object.assign(new Error('changed browser'),{code:'IDENTITY_MISMATCH'});},resources}),/changed browser/);
await assert.rejects(applyTargets({pages:[{id:'active'}],connect,resources:async()=>{throw new Error('tampered theme');}}),/tampered theme/);
assert.equal(transient({code:'IDENTITY_MISMATCH'}),false);
const order=[];
await applyTargets({pages:[{id:'active'}],connect:async()=>({close(){},evaluate:async expression=>{
 if(expression.startsWith('Boolean(document.visibility'))return true;
 if(expression.includes('__CODEX_DREAM_SKIN_STATE__'))return false;
 if(expression.endsWith('("applying")'))order.push('applying');
 if(expression==='fixed-theme')order.push('payload');
 if(expression.endsWith('("ready")'))order.push('ready');
 return true;
}}),resources,verify:async()=>{order.push('validated');return {pass:true};}});
assert.deepEqual(order,['applying','payload','validated','ready'],'stage feedback follows actual apply and verification');
// Preparation must overlap theme work, but visibility waits for both tasks.
const startupOrder=[];let finishPreparation;
await applyTargets({pages:[{id:'active'}],resources,
 prepareOpening:()=>{startupOrder.push('prepare');return new Promise(resolve=>{finishPreparation=()=>{startupOrder.push('prepared');resolve();};});},
 connect:async()=>({close(){},evaluate:async expression=>{
  if(expression.startsWith('Boolean(document.visibility'))return true;
  if(expression.includes('__CODEX_DREAM_SKIN_STATE__'))return false;
  if(expression==='fixed-theme')startupOrder.push('payload');
  if(expression.endsWith('("ready")')){startupOrder.push('ready');finishPreparation();}
  return true;
 }}),verify:async()=>{startupOrder.push('verified');return {pass:true};},
 opening:async()=>startupOrder.push('visible')});
assert.deepEqual(startupOrder,['prepare','payload','verified','ready','prepared','visible']);
const session=new Session('ws://127.0.0.1:19337/devtools/page/test');
const deadlines=[];session.send=async(method,params,deadline)=>{deadlines.push(deadline);assert.equal(params.awaitPromise,true);return {result:{value:'ready'}};};
assert.equal(await session.evaluate('Promise.resolve("ready")',{timeoutMs:15000}),'ready');
await session.evaluate('true');assert.deepEqual(deadlines,[15000,3000],'media timeout does not change ordinary command deadline');
for(const [installedCss,expectedInstalls]of [['old-css',1],['fixed-css',0]]){
 let installs=0;const sheet={};
 const context={window:{__SANDRONE_NATIVE_UI__:{version:'0.5.3',css:installedCss,sheet}},document:{adoptedStyleSheets:[sheet]}};
 await applyTargets({pages:[{id:'active'}],resources,connect:async()=>({close(){},evaluate:async expression=>{
  if(expression.startsWith('Boolean(document.visibility'))return true;
  if(expression.includes('__CODEX_DREAM_SKIN_STATE__'))return true;
  if(expression.startsWith('window.__SANDRONE_NATIVE_UI__'))return vm.runInNewContext(expression,context);
  if(expression.startsWith('(function installNativeUi')){installs++;return {installed:true};}
  return true;
 }})});
 assert.equal(installs,expectedInstalls,'CSS changes at the same version must refresh the owned sheet');
}
console.log('PASS: hidden-target isolation, reload recovery, sibling resilience, identity/tamper failures stay fatal');

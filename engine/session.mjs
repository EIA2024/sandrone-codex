import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPayload,verifySession} from '../vendor/dream-skin/windows/scripts/injector.mjs';
import {appPages,identity,Session} from './cdp.mjs';
import {removeNativeUi,installNativeUi} from './renderer.mjs';
import {openingAssets} from './assets.mjs';
import {prepareOpening,showOpening} from './opening-client.mjs';
import {applyTargets,call,transient,healthyHiddenTheme} from './target-runner.mjs';
import {watchSignal} from './watch-signal.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),mode=args[0],browserId=args[args.indexOf('--browser-id')+1];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let resourcesPromise,assetsPromise,openingShown=false;
const resources=()=>resourcesPromise??=Promise.all([loadPayload(path.join(root,'themes/sandrone')),fs.readFile(path.join(root,'engine/native-ui.css'),'utf8')]).then(([loaded,css])=>({loaded,css}));
const connect=page=>new Session(page.webSocketDebuggerUrl).open();
const evaluators=new WeakMap();
const evaluateFor=session=>{if(!evaluators.has(session))evaluators.set(session,(code,options)=>session.evaluate(code,options));return evaluators.get(session);};
const assets=()=>assetsPromise??=openingAssets();
async function prepare(session){return prepareOpening(evaluateFor(session),await assets());}
async function opening(session,prepared){
 if(openingShown)return;
 // Reserve the single opening before awaiting assets so two targets cannot race.
 openingShown=true;
 try{await showOpening(evaluateFor(session),await assets(),{},prepared);}catch(error){openingShown=false;throw error;}
}
async function apply({start=false,force=false,verify=false,connector=connect}={}){
 return applyTargets({pages:await appPages(browserId),connect:connector,resources,verify:verify?verifySession:null,prepareOpening:start?prepare:null,opening:start?opening:null,force});
}
async function waitReady(start,timeoutMs=25000){
 const began=Date.now(),deadline=began+timeoutMs;
 do{
  try{const result=await apply({start,verify:true});if(result.ready)return {pass:true,status:'ready',elapsedMs:Date.now()-began};}
  catch(error){if(!transient(error))throw error;}
  await sleep(250);
 }while(Date.now()<deadline);
 return {pass:false,status:'waiting',code:'RENDERER_NOT_READY',elapsedMs:Date.now()-began};
}
async function resume(){
 const began=Date.now(),{loaded,css}=await resources();
 for(const page of await appPages(browserId)){
  const session=await connect(page);
  try{
   // An already themed hidden main window may receive our fixed accessibility
   // component update. This does not install or verify a new upstream theme.
   const existing=await session.evaluate(`Boolean(document.hidden&&document.documentElement.getAttribute('data-dream-skin')==='active'&&window.__CODEX_DREAM_SKIN_STATE__?.revision===${JSON.stringify(loaded.revision)}&&document.querySelector('[data-ds-part="composer"]'))`);
   if(existing)await session.evaluate(call(installNativeUi,css));
   if(await session.evaluate(call(healthyHiddenTheme,loaded.revision,css)))return {pass:true,status:'reused',visible:false,elapsedMs:Date.now()-began};
  }
  catch(error){if(!transient(error))throw error;}finally{await session.close();}
 }
 return waitReady(false,3000);
}
async function watch(){
 const anchor=await new Session(await identity(browserId)).open();
 const signal=watchSignal(),pool=new Map();
 anchor.onEvent(method=>{if(method==='Target.targetCreated'||method==='Target.targetInfoChanged'||method==='Target.targetDestroyed')signal.wake();});
 await anchor.send('Target.setDiscoverTargets',{discover:true});
 const pooled=async page=>{
  let session=pool.get(page.id);
  if(!session||session.closed){
   session=await connect(page);pool.set(page.id,session);
   let replaying=false;
   session.onEvent((method,params)=>{
    if(method==='Runtime.executionContextsCleared'||method==='Runtime.executionContextDestroyed')signal.wake();
    if(method==='Runtime.bindingCalled'&&params.name==='sandroneReplayOpening'&&params.payload==='replay'&&!replaying){
     replaying=true;
     (async()=>{
      if(await session.evaluate(`document.visibilityState==='visible'&&document.documentElement.getAttribute('data-dream-skin')==='active'`))await showOpening(evaluateFor(session),await assets(),{replay:true});
     })().catch(()=>signal.wake()).finally(()=>{replaying=false;});
    }
   });
   await session.send('Runtime.enable');
   await session.send('Runtime.addBinding',{name:'sandroneReplayOpening'});
  }
  return {evaluate:(expression,options)=>session.evaluate(expression,options),send:(...args)=>session.send(...args),close(){}};
 };
 try{
  while(!anchor.closed){
   try{await fs.access(path.join(root,'state/paused'));break;}catch{}
   let ready=false;
   try{const result=await apply({connector:pooled});ready=result.ready||result.idle;}catch(error){if(anchor.closed)break;if(!transient(error))throw error;}
   for(const [id,s]of pool)if(s.closed){s.close();pool.delete(id);}
   await signal.wait(ready?15000:1500);
  }
 }finally{signal.dispose();for(const s of pool.values()){try{await s.send('Runtime.removeBinding',{name:'sandroneReplayOpening'});}catch{}s.close();}anchor.close();}
}
async function diagnostic(){
 let count=0;
 for(const page of await appPages(browserId)){
  const session=await connect(page);
  try{
   if(mode==='--remove')await session.evaluate(call(removeNativeUi));
   if(mode==='--opening'){if(await session.evaluate(`document.visibilityState==='visible'&&Boolean(document.querySelector('button,[role="main"]'))`))await opening(session);}
   if(mode==='--metrics')console.log(JSON.stringify(await session.evaluate(`(()=>({skin:document.documentElement.getAttribute('data-dream-skin'),extension:window.__SANDRONE_NATIVE_UI__?.version,opening:window.__SANDRONE_OPENING_STATE__?.stage,visible:document.visibilityState,composer:Boolean(document.querySelector('[data-ds-part="composer"]'))}))()`)));
   if(mode==='--health'){
    const {loaded}=await resources();const v=await verifySession(session,page.id,loaded.theme.id,loaded.revision);
    console.log(JSON.stringify({pass:v.pass,readiness:v.readiness,installed:v.installed,stylePresent:v.stylePresent,homePresent:v.homePresent,homeComposerPass:v.homeComposerPass,overflow:v.documentOverflow,pollution:v.businessClassPollution,scope:v.scope?.level,version:v.version,homeSurface:v.homeSurface,composer:v.composer,nativeReason:v.nativeWindow?.reason}));
   }
   if(mode==='--snapshot'){
    if(!await session.evaluate(`document.visibilityState==='visible'&&Boolean(document.querySelector('button,[role="main"]'))`))continue;
    const shot=await session.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.mkdir(path.join(root,'evidence'),{recursive:true});await fs.writeFile(path.join(root,'evidence','native-readable-0.3.0.png'),Buffer.from(shot.data,'base64'));break;
   }
   count++;
  }finally{await session.close();}
 }
 return {pass:true,targets:count};
}
try{
 if(!['--apply','--ready','--resume','--start','--watch','--opening','--remove','--snapshot','--metrics','--health'].includes(mode)||!args.includes('--browser-id'))throw new Error('Unsupported fixed engine operation');
 if(mode==='--watch')await watch();
 else{
  const result=mode==='--resume'?await resume():mode==='--start'||mode==='--ready'?await waitReady(mode==='--start'):mode==='--apply'?await apply({force:true,verify:true}):await diagnostic();
  if(mode==='--apply'){result.pass=result.ready;result.status=result.ready?'ready':'waiting';}
  console.log(JSON.stringify(result));if(result.pass===false)process.exitCode=result.status==='waiting'?2:1;
 }
}catch(error){
 console.log(JSON.stringify({pass:false,code:error.code||'ENGINE_UNAVAILABLE',message:error.message}));process.exitCode=1;
}

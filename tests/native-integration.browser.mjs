// Isolated Chromium + an Electron API adapter, not an Electron/AppX acceptance test.
// PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE select an existing browser runtime.
// SANDRONE_THEME_SOURCE optionally points to another checkout (e.g. opening perf).
// This copies real theme sources into a temporary package; it never uses Codex
// userData, installed packages, the debugger port, or an uninstall worker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(process.env.SANDRONE_THEME_SOURCE||root);
const {startIntegration}=require('../native-integration/runtime/integration.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'sandrone-native-browser-'));
const installationRoot=path.join(temporary,'package');
const themeRoot=path.join(installationRoot,'theme');
const userData=path.join(temporary,'user-data');
const exists=file=>fs.access(file).then(()=>true,()=>false);
const perf=await exists(path.join(source,'engine/opening-client.mjs'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate,message,timeout=20000)=>{
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await predicate())return;await pause(25);}
 throw new Error('Timed out: '+message);
};
let browser,win,resumeTransfer;
const checks=[],measurements={};
try {
 await fs.mkdir(themeRoot,{recursive:true});
 for(const directory of ['engine','vendor','themes','assets']){
  await fs.cp(path.join(source,directory),path.join(themeRoot,directory),{recursive:true});
 }
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1280,height:720}});
 await page.setContent('<!doctype html><html><body><p id="login">Signing in</p></body></html>');
 const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 const expressions=[],actions=[];
 let probes=0,holdTransfer=false,transferHeld=false;
 class WebContents extends EventEmitter {
  mainFrame={fixture:'main-frame'};
  isDestroyed(){return false;}
  isLoading(){return false;}
  getURL(){return 'app://-/index.html';}
  async executeJavaScript(expression){
   expressions.push(expression.length);
   if(expression.startsWith("Boolean(document.querySelector('aside.app-shell-left-panel')"))probes++;
   if(holdTransfer&&expression.includes('.push(')&&expression.includes('__SANDRONE_OPENING_INPUT__')){
    holdTransfer=false;transferHeld=true;
    await new Promise(resolve=>{resumeTransfer=resolve;});
   }
   return page.evaluate(expression);
  }
 }
 class Window extends EventEmitter {
  id=1;destroyed=false;webContents=new WebContents();
  isDestroyed(){return this.destroyed;}
  close(){this.destroyed=true;this.emit('closed');}
 }
 win=new Window();
 page.on('console',message=>{
  if(!message.text().startsWith('__SANDRONE_NATIVE_'))return;
  actions.push(message.text());
  win.webContents.emit('console-message',{frame:win.webContents.mainFrame,message:message.text()});
 });
 const app=new EventEmitter();app.getPath=name=>{assert.equal(name,'userData');return userData;};app.whenReady=async()=>{};
 const integration=startIntegration({app,BrowserWindow:{getAllWindows:()=>[win]},dialog:{showMessageBox:()=>{throw new Error('Unexpected uninstall prompt');}}},installationRoot,{addonPackageFullName:'fixture-only'});
 const {manager,dataRoot}=integration;
 const clickAction=async name=>{
  const count=actions.length;
  await page.evaluate(action=>{
   const button=document.querySelector('#sandrone-native-controls')?.shadowRoot.querySelector(`[data-action="${action}"]`);
   if(!button||button.disabled)throw new Error('Unavailable theme action: '+action);
   // Run the actual menu item handler without opening its status menu, which
   // intentionally invokes the separate native management worker.
   button.click();
  },name);
  await until(()=>actions.length>count,'renderer action reached main-frame adapter');
  await manager.queue;
  assert.equal(manager.error,'');
 };
 await until(()=>probes>=2,'delayed shell probe');
 assert.equal(await page.locator('#sandrone-native-controls').count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-dream-skin')),false);
 await page.evaluate(()=>{
  document.body.innerHTML='<aside class="app-shell-left-panel"><button>New chat</button></aside><main class="main-surface" data-app-shell-main-surface><div role="main"><form><textarea aria-label="Message" style="width:600px;height:90px"></textarea></form></div></main>';
 });
 await page.waitForFunction(()=>window.__SANDRONE_OPENING_STATE__?.stage==='playing',{},{timeout:20000});
 await manager.queue;
 assert.equal(manager.error,'');
 assert.equal(await page.evaluate(()=>document.documentElement.getAttribute('data-dream-skin')),'active');
 assert.equal(await page.locator('#sandrone-native-controls').count(),1);
 checks.push('late-shell-readiness','packaged-theme-root-and-startup-opening');
 if(perf){
  assert.equal(await page.evaluate(()=>window.__SANDRONE_MEDIA_CACHE__.color.videoWidth),1920);
  await page.evaluate(()=>{window.fixtureColor=window.__SANDRONE_MEDIA_CACHE__.color;});
 }
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>window.__SANDRONE_OPENING_STATE__?.stage==='finished');
 expressions.length=0;
 await clickAction('replay');
 assert.equal(await page.evaluate(()=>window.__SANDRONE_OPENING_STATE__.stage),'playing');
 if(perf){
  assert.equal(await page.evaluate(()=>window.fixtureColor===window.__SANDRONE_MEDIA_CACHE__.color),true);
  // Controls update contains its fixed function, but neither assets nor player
  // should be serialized again. Renderer state queries stay below 2 KiB.
  assert.equal(expressions.filter(size=>size>20000).length,0);
  measurements.largestReplayExpressionChars=Math.max(...expressions);
  checks.push('shared-client-cached-replay');
 }
 await clickAction('disable');
 assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-dream-skin')),false);
 assert.equal(await page.locator('#sandrone-native-controls').count(),1,'management remains available on native UI');
 assert.equal(await page.locator('#sandrone-opening,#sandrone-opening-cached,#sandrone-media-parking').count(),0);
 if(perf)assert.equal(await page.evaluate(()=>window.fixtureColor.getAttribute('src')),null);
 assert.equal(JSON.parse(await fs.readFile(path.join(dataRoot,'settings.json'),'utf8')).enabled,false);
 checks.push('menu-disable-cleans-media-and-persists');
 await clickAction('enable');
 assert.equal(await page.evaluate(()=>document.documentElement.getAttribute('data-dream-skin')),'active');
 assert.equal(await page.locator('#sandrone-opening').count(),0,'enable does not force another opening');
 assert.equal(JSON.parse(await fs.readFile(path.join(dataRoot,'settings.json'),'utf8')).enabled,true);
 checks.push('menu-enable-and-persistence');
 if(perf){
  // Hold one real media transfer chunk while the actual disable console action
  // invalidates its evaluator generation and cancels the renderer token.
  holdTransfer=true;
  const replay=clickAction('replay');
  await until(()=>transferHeld,'real opening transfer chunk');
  const disable=clickAction('disable');
  await until(()=>page.evaluate(()=>!window.__SANDRONE_OPENING_INPUT__),'immediate disable cancels transfer');
  resumeTransfer();resumeTransfer=null;
  await Promise.all([replay,disable]);
  assert.equal(manager.preferences.enabled,false);
  assert.equal(await page.locator('#sandrone-opening,#sandrone-opening-cached,#sandrone-media-parking').count(),0);
  assert.equal(await page.evaluate(()=>Boolean(window.__SANDRONE_PLAYER__||window.__SANDRONE_MEDIA_CACHE__)),false);
  checks.push('disable-during-transfer-cannot-revive');
  await clickAction('enable');await clickAction('replay');
  assert.equal(await page.evaluate(()=>window.__SANDRONE_OPENING_STATE__.stage),'playing');
  await clickAction('disable');checks.push('new-generation-replay-recovers');
 }
 assert.deepEqual(pageErrors,[]);
 const log=await fs.readFile(path.join(dataRoot,'events.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
 assert.equal(log,'','runtime must not silently log integration errors');
 console.log(JSON.stringify({pass:true,scope:'real runtime and theme payload in Chromium with an Electron adapter; not Electron/AppX installation or subjective smoothness acceptance',browser:browser.version(),openingClient:perf,checks,measurements}));
} finally {
 resumeTransfer?.();win?.close();await browser?.close();
 const resolved=path.resolve(temporary);
 if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('sandrone-native-browser-'))throw new Error('Unexpected fixture cleanup path');
 await fs.rm(resolved,{recursive:true,force:true});
}

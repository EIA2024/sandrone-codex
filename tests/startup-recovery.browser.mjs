// Regression for a real user reaching recovery under the modal startup cover.
// Isolated Chromium only: no Codex connection, package changes or worker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {installStartupScreen}=require('../native-integration/runtime/startup-preload.cjs');
const {installControls}=require('../native-integration/runtime/controls.cjs');
const {startupState,updateHost}=require('../native-integration/runtime/startup-readiness.cjs');
const root=path.resolve(import.meta.dirname,'..');
const poster='data:image/jpeg;base64,'+(await fs.readFile(path.join(root,'assets/motion/sandrone-startup-still.jpg'))).toString('base64');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const preferences={enabled:true,openingOnLaunch:true,autoEnterOnReady:false};
 const config={token:'recovery-test',show:true,preferences,media:{intro:null,loop:null,poster,still:poster}};
 await page.setContent('<!doctype html><html><body><aside class="app-shell-left-panel">Projects</aside><main class="main-surface"><textarea style="width:600px;height:90px" aria-label="Message"></textarea></main></body></html>');
 await page.evaluate(`(${installControls.toString()})('test:',${JSON.stringify({...preferences,uninstallStatus:'idle',error:''})})`);
 const menu=page.locator('#sandrone-native-controls').getByRole('button',{name:'主题管理',exact:true});
 await menu.click();await menu.click();
 const mount=()=>page.evaluate(`window.controller?.dispose();window.actions=[];window.controller=(${installStartupScreen.toString()})(${JSON.stringify(config)},(action,detail={})=>actions.push({action,...detail}));`);
 const receive=message=>page.evaluate(message=>controller.receive({token:'recovery-test',...message}),message);
 const native=page.locator('#sandrone-startup').getByRole('button',{name:'使用原生界面',exact:true});
 const retry=page.locator('#sandrone-startup').getByRole('button',{name:'重试检查',exact:true});
 const probe={workspace:true,structure:true,theme:true};
 const failedHosts=new Map();updateHost(failedHosts,{type:'codex-app-server-connection-changed',hostId:'local',state:'error'});
 await mount();
 assert.equal(await native.isVisible(),false,'normal loading keeps the uncluttered opening');
 await receive({kind:'state',state:startupState(probe,failedHosts,false,1000)});
 assert.equal(await native.isVisible(),true,'a failed service must expose recovery inside the cover');
 assert.equal(await retry.isVisible(),true);
 // These are ordinary browser clicks and keys, not forced clicks or manager calls.
 await retry.click();
 assert.equal(await page.evaluate(()=>actions.at(-1).action),'retry');
 await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.getElementById('sandrone-startup').shadowRoot.activeElement?.dataset.action),'native');
 await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>actions.at(-1).action),'native');
 assert.equal(await page.evaluate(()=>actions.some(item=>item.action==='enter')),false,'recovery does not fake readiness');
 await receive({kind:'preferences',preferences:{...preferences,enabled:false}});
 assert.equal(await page.locator('#sandrone-startup').count(),0);
 await page.getByRole('textbox',{name:'Message'}).click();
 await menu.click();await menu.click();

 await mount();
 await receive({kind:'state',state:startupState(probe,new Map(),false,30001)});
 assert.equal(await native.isVisible(),true,'a timeout also exposes recovery without inventing completed progress');
 await native.click();assert.equal(await page.evaluate(()=>actions.at(-1).action),'native');
 await receive({kind:'state',state:startupState({...probe,imageError:true,theme:false},new Map(),false,1000)});
 assert.equal(await native.isVisible(),true,'theme image failures expose recovery');
 if(process.env.SANDRONE_TEST_ARTIFACTS){
  await fs.mkdir(process.env.SANDRONE_TEST_ARTIFACTS,{recursive:true});
  await page.screenshot({path:path.join(process.env.SANDRONE_TEST_ARTIFACTS,'startup-recovery-fixed.png')});
 }
 const readyHosts=new Map();
 updateHost(readyHosts,{type:'codex-app-server-initialized',hostId:'local'});
 updateHost(readyHosts,{type:'codex-app-server-connection-changed',hostId:'local',state:'connected'});
 await receive({kind:'state',state:startupState(probe,readyHosts,true,60000)});
 assert.equal(await native.isVisible(),false,'ready manual mode hides recovery even after a long wait');
 assert.equal(await page.evaluate(()=>document.getElementById('sandrone-startup').shadowRoot.activeElement?.classList.contains('screen')),true,'hiding a focused recovery button returns keyboard focus to the screen');
 await page.keyboard.press('Space');await page.keyboard.press('Space');
 assert.equal(await page.evaluate(()=>actions.at(-1).reason),'double-key','manual keyboard entry remains usable after recovery clears');
 await receive({kind:'state',state:startupState({...probe,login:true,workspace:false},new Map(),false,1000)});
 assert.equal(await page.getByRole('button',{name:'继续登录',exact:true}).isVisible(),true);
 assert.equal(await native.isVisible(),true);assert.equal(await retry.isVisible(),false);
 await page.getByRole('button',{name:'继续登录',exact:true}).click();
 assert.equal(await page.evaluate(()=>actions.at(-1).action),'login');
 await page.evaluate(()=>controller.dispose());assert.deepEqual(errors,[]);
 console.log(JSON.stringify({pass:true,checks:['service-error-recovery-click','recovery-keyboard-access','retry-without-fake-ready','native-restores-access-to-editor-and-menu','timeout-recovery','image-failure-recovery','hide-recovery-on-ready','login-retains-native-recovery']}));
}finally{await browser.close();}

// Real Chromium + the production startup renderer/probe. Electron IPC and
// native package activation are validated separately; this test claims neither.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { installStartupScreen } = require('../native-integration/runtime/startup-preload.cjs');
const { inspectWorkspace } = require('../native-integration/runtime/startup-readiness.cjs');
const { hostContract, inspectShell } = require('../native-integration/runtime/host-adapter.cjs');
const root = path.resolve(import.meta.dirname, '..');
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (!name) { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html><body><div class="startup-loader">Official loader</div></body></html>'); return; }
  if (!/^sandrone-startup-(intro|idle|poster)\.(mp4|jpg)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const bytes = await fs.readFile(path.join(root, 'assets/motion', name));
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : bytes.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    response.end(bytes.subarray(start, end + 1));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const config = { host: hostContract, token: 'document-1', show: true, preferences: { enabled: true, autoEnterOnReady: false }, media: { intro: `${url}/sandrone-startup-intro.mp4`, loop: `${url}/sandrone-startup-idle.mp4`, poster: `${url}/sandrone-startup-poster.jpg` } };
  const firstPage = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
  await firstPage.addInitScript({ content: `window.earlyController=(${installStartupScreen.toString()})(${JSON.stringify(config)},()=>{});requestAnimationFrame(()=>{window.firstPaintHasCover=document.elementFromPoint(640,360)?.id==='sandrone-startup';});` });
  await firstPage.goto(url);
  await firstPage.waitForFunction(() => window.firstPaintHasCover !== undefined);
  assert.equal(await firstPage.evaluate(() => window.firstPaintHasCover), true);
  await firstPage.close(); checks.push('document-start-overlay-before-first-animation-frame');
  const start = async override => {
    await page.evaluate(() => window.screenController?.dispose());
    await page.setContent('<html><body><button id="previous">Previous focus</button><div id="root"><div class="startup-loader">Official loader</div></div></body></html>');
    await page.evaluate(`window.actions=[];window.screenController=(${installStartupScreen.toString()})(${JSON.stringify({ ...config, ...override })},(action,detail)=>actions.push({action,...detail}));`);
  };
  const receive = message => page.evaluate(value => screenController.receive({ token: 'document-1', ...value }), message);
  const ready = { steps: [true, true, true, true, true], ready: true, status: '工作区与桑多涅主题已就绪' };
  await start();
  assert.equal(await page.locator('#sandrone-startup').count(), 1);
  await page.locator('#sandrone-startup .screen').dblclick();
  await page.keyboard.press('Space'); await page.keyboard.press('Space'); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => actions.some(action => action.action === 'enter')), false);
  await page.evaluate(() => { document.getElementById('root').innerHTML = '<main>React mounted</main>'; });
  assert.equal(await page.locator('#sandrone-startup').count(), 1);
  checks.push('overlay-before-workspace-and-survives-root-replacement', 'cannot-skip-before-ready');
  await receive({ kind: 'state', state: ready });
  await page.waitForFunction(() => document.getElementById('sandrone-startup').dataset.introDone === 'true');
  assert.equal(await page.evaluate(() => actions.some(action => action.action === 'enter')), false);
  await page.waitForFunction(() => { const video = document.querySelector('#sandrone-startup').shadowRoot.querySelector('video'); return video?.loop && video.videoWidth === 1920; });
  await page.locator('#sandrone-startup .screen').dblclick();
  assert.equal(await page.evaluate(() => actions.at(-1).reason), 'double-click');
  await receive({ kind: 'state', state: { ...ready, ready: false, steps: [true, false, true, true, false] } });
  await receive({ kind: 'enter', reason: 'double-click' });
  assert.equal(await page.locator('#sandrone-startup').count(), 1);
  await receive({ kind: 'state', state: ready }); await receive({ kind: 'enter', reason: 'double-click' });
  await page.waitForFunction(() => !document.getElementById('sandrone-startup'));
  checks.push('manual-stays-and-loops-after-ready', 'entry-revoked-after-view-unready');
  await start({ preferences: { enabled: true, autoEnterOnReady: true } });
  await receive({ kind: 'state', state: ready });
  assert.equal(await page.evaluate(() => actions.some(action => action.action === 'enter')), false);
  await page.waitForFunction(() => actions.some(action => action.action === 'enter' && action.reason === 'auto'));
  await receive({ kind: 'enter', reason: 'auto' });
  await page.waitForFunction(() => !document.getElementById('sandrone-startup'));
  checks.push('auto-requires-real-ready-and-complete-intro');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start();
  assert.equal(await page.locator('#sandrone-startup video').count(), 0);
  await receive({ kind: 'state', state: { ...ready, ready: false, recovery: true, login: true } });
  assert.equal(await page.getByRole('button', { name: '继续登录' }).isVisible(), true);
  await receive({ kind: 'preferences', preferences: { enabled: false, autoEnterOnReady: false } });
  await receive({ kind: 'state', state: ready });
  assert.equal(await page.locator('#sandrone-startup').count(), 0);
  checks.push('reduced-motion-static-fallback', 'recovery-controls', 'disable-cannot-revive');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await start({ media: { ...config.media, intro: `${url}/missing.mp4` } });
  await page.waitForFunction(() => !document.getElementById('sandrone-startup'));
  assert.equal(await page.evaluate(() => actions.some(action => action.action === 'degraded' && action.reason === 'media-error')), true);
  checks.push('broken-media-releases-workspace');
  await page.evaluate(() => screenController.dispose());
  await page.setContent('<html data-dream-skin="active"><body><aside class="app-shell-left-panel">Navigation</aside><main class="main-surface"><textarea style="width:400px;height:80px"></textarea></main></body></html>');
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet(); sheet.replaceSync('body{background:#123}'); document.adoptedStyleSheets = [sheet];
    window.__CODEX_DREAM_SKIN_STATE__ = { themeId: 'sandrone', revision: 'expected', styleMode: 'adopted', styleSheet: sheet };
    window.__SANDRONE_NATIVE_UI__ = { sheet };
  });
  const inspect = () => page.evaluate(`(${inspectWorkspace.toString()})({themeId:'sandrone',revision:'expected'},${JSON.stringify(hostContract)})`);
  assert.equal((await inspect()).theme, true);
  let releaseImage;
  const imageGate = new Promise(resolve => { releaseImage = resolve; });
  await page.route(`${url}/delayed.jpg`, async route => {
    await imageGate;
    await route.fulfill({ contentType: 'image/jpeg', body: await fs.readFile(path.join(root, 'assets/motion/sandrone-startup-poster.jpg')) });
  });
  await page.evaluate(src => document.body.style.backgroundImage = `url("${src}")`, `${url}/delayed.jpg`);
  assert.equal((await inspect()).theme, false, 'theme background must decode before ready');
  releaseImage();
  await page.waitForFunction(`(${inspectWorkspace.toString()})({themeId:'sandrone',revision:'expected'},${JSON.stringify(hostContract)}).then(result=>result.theme)`);
  await page.evaluate(() => { document.querySelector('textarea').disabled = true; const button = document.createElement('button'); button.textContent = 'Unrelated action'; document.querySelector('main').append(button); });
  assert.equal((await inspect()).structure, false, 'an unrelated button cannot stand in for a disabled composer');
  await page.evaluate(() => { window.__CODEX_DREAM_SKIN_STATE__.revision = 'stale'; });
  assert.equal((await inspect()).theme, false);
  await page.evaluate(() => {
    window.__CODEX_DREAM_SKIN_STATE__.revision = 'expected';
    document.querySelector('main').innerHTML = '<div data-settings-panel-slug="general-settings"><button>Settings</button></div>';
  });
  assert.equal((await inspect()).structure, true);
  await page.evaluate(() => document.adoptedStyleSheets = []);
  assert.equal((await inspect()).theme, false);
  checks.push('actual-stylesheet-revision-and-route-checks');
  checks.push('delayed-theme-image-gates-readiness', 'disabled-composer-is-not-interactive');
  await page.evaluate(() => document.querySelector('aside').remove());
  assert.equal((await inspect()).workspace, false);
  assert.equal(await page.evaluate(`(${inspectShell.toString()})(${JSON.stringify(hostContract)})`), true, 'one supported surface is enough to retain applicable visuals');
  checks.push('partial-shell-retains-supported-surfaces');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Freeze the clock before mounting: wall time between Playwright calls must
  // not move the 29,999 ms boundary past the 30-second deadline.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await start();
  await page.clock.fastForward(29999);
  assert.equal(await page.locator('#sandrone-startup').count(), 1);
  await page.clock.fastForward(1);
  assert.equal(await page.locator('#sandrone-startup').count(), 0);
  assert.equal(await page.evaluate(() => actions.some(action => action.reason === 'readiness-timeout')), true);
  await start();
  await receive({ kind: 'state', state: { ...ready, serviceStatus: 'unknown' } });
  await page.clock.fastForward(60000);
  assert.equal(await page.locator('#sandrone-startup').count(), 1, 'manual mode stays after real view readiness');
  await receive({ kind: 'degraded' });
  assert.equal(await page.locator('#sandrone-startup').count(), 0);
  await start();
  await receive({ kind: 'preferences', preferences: { enabled: false, autoEnterOnReady: false } });
  await page.clock.fastForward(30000);
  assert.equal(await page.locator('#sandrone-startup').count(), 0);
  await page.evaluate(`window.screenController=(${installStartupScreen.toString()})(${JSON.stringify(config)},()=>{throw new Error('IPC unavailable')});`);
  await page.clock.fastForward(30000);
  assert.equal(await page.locator('#sandrone-startup').count(), 0, 'cleanup does not depend on IPC');
  checks.push('renderer-autonomous-30s-release', 'manual-ready-not-timed-out', 'degraded-release', 'IPC-throw-does-not-block-cleanup');
  const noReply = await browser.newPage({ reducedMotion: 'reduce' });
  await noReply.setContent('<html><body><button id="usable">Still usable</button></body></html>');
  await noReply.evaluate(() => {
    window.process = { isMainFrame: true };
    window.fixtureListeners = new Map(); window.fixtureSends = [];
    window.require = () => ({ ipcRenderer: {
      on: (name, fn) => fixtureListeners.set(name, fn),
      removeListener: name => fixtureListeners.delete(name),
      send: (name, value) => fixtureSends.push({ name, value }),
      sendSync: () => { throw new Error('Blocking IPC is forbidden'); },
    } });
  });
  await noReply.addScriptTag({ content: await fs.readFile(path.join(root, 'native-integration/runtime/startup-preload.cjs'), 'utf8') });
  assert.equal(await noReply.locator('#sandrone-startup').count(), 0);
  await noReply.locator('#usable').click();
  assert.equal(await noReply.evaluate(() => fixtureSends[0].name), 'sandrone:startup-bootstrap');
  await noReply.evaluate(value => {
    const reply = fixtureListeners.get('sandrone:startup-state');
    reply(null, { kind: 'bootstrap', config: value });
    reply(null, { kind: 'bootstrap', config: value });
  }, config);
  assert.equal(await noReply.locator('#sandrone-startup').count(), 1);
  await noReply.close();
  checks.push('missing-bootstrap-reply-leaves-app-usable', 'delayed-bootstrap-mounts-once');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, browser: browser.version(), checks }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

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
  const config = { token: 'document-1', show: true, preferences: { enabled: true, autoEnterOnReady: false }, media: { intro: `${url}/sandrone-startup-intro.mp4`, loop: `${url}/sandrone-startup-idle.mp4`, poster: `${url}/sandrone-startup-poster.jpg` } };
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
  checks.push('manual-stays-and-loops-after-ready', 'entry-revoked-after-disconnect');
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
  await page.waitForFunction(() => document.getElementById('sandrone-startup').dataset.introDone === 'true');
  assert.equal(await page.locator('#sandrone-startup video').count(), 0);
  checks.push('broken-media-fallback');
  await page.evaluate(() => screenController.dispose());
  await page.setContent('<html data-dream-skin="active"><body><aside class="app-shell-left-panel">Navigation</aside><main class="main-surface"><textarea style="width:400px;height:80px"></textarea></main></body></html>');
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet(); sheet.replaceSync('body{background:#123}'); document.adoptedStyleSheets = [sheet];
    window.__CODEX_DREAM_SKIN_STATE__ = { themeId: 'sandrone', revision: 'expected', styleMode: 'adopted', styleSheet: sheet };
    window.__SANDRONE_NATIVE_UI__ = { sheet };
  });
  const inspect = () => page.evaluate(`(${inspectWorkspace.toString()})({themeId:'sandrone',revision:'expected'})`);
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
  await page.waitForFunction(`(${inspectWorkspace.toString()})({themeId:'sandrone',revision:'expected'}).then(result=>result.theme)`);
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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, browser: browser.version(), checks }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

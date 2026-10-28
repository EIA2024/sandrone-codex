// Real mouse/keyboard recovery after the opening releases a failed workspace.
// Isolated Chromium only; never connects to Codex or changes Windows packages.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { installStartupScreen } = require('../native-integration/runtime/startup-preload.cjs');
const { installControls } = require('../native-integration/runtime/controls.cjs');
const { startupState, updateHost } = require('../native-integration/runtime/startup-readiness.cjs');
const { hostContract } = require('../native-integration/runtime/host-adapter.cjs');
const root = path.resolve(import.meta.dirname, '..');
const poster = 'data:image/jpeg;base64,' + (await fs.readFile(path.join(root, 'assets/motion/sandrone-startup-still.jpg'))).toString('base64');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const errors = [], menuActions = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().startsWith('test:')) menuActions.push(message.text().slice(5)); });
  const preferences = { enabled: true, openingOnLaunch: true, autoEnterOnReady: false };
  const config = { token: 'recovery-test', show: true, preferences, host: hostContract, media: { intro: null, loop: null, poster, still: poster } };
  await page.setContent('<!doctype html><html data-dream-skin="active"><body><aside class="app-shell-left-panel">Projects</aside><main class="main-surface"><textarea style="width:600px;height:90px" aria-label="Message"></textarea></main></body></html>');
  await page.evaluate(`(${installControls.toString()})('test:',${JSON.stringify({ ...preferences, uninstallStatus: 'idle', error: '' })},${JSON.stringify(hostContract)})`);
  const menu = page.locator('#sandrone-native-controls').getByRole('button', { name: '主题管理', exact: true });
  const editor = page.getByRole('textbox', { name: 'Message' });
  const mount = async () => {
    await page.evaluate(() => window.controller?.dispose());
    await editor.click();
    await page.evaluate(`window.actions=[];window.controller=(${installStartupScreen.toString()})(${JSON.stringify(config)},(action,detail={})=>actions.push({action,...detail}));`);
  };
  const receive = message => page.evaluate(message => controller.receive({ token: 'recovery-test', ...message }), message);
  const probe = { workspace: true, structure: true, theme: true };
  const failedHosts = new Map();
  updateHost(failedHosts, { type: 'codex-app-server-connection-changed', hostId: 'local', state: 'error' });
  await page.clock.install();
  await mount();
  await receive({ kind: 'state', state: startupState(probe, failedHosts, true, 1000) });
  assert.equal(await page.locator('#sandrone-startup').getAttribute('data-ready'), 'true', 'service failure does not invalidate an observed usable view');
  assert.equal(await page.locator('#sandrone-startup').getAttribute('data-service-status'), 'error');
  await page.clock.fastForward(60000);
  assert.equal(await page.locator('#sandrone-startup').count(), 1, 'ready manual mode still waits for the user');
  await page.keyboard.press('Space'); await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => actions.at(-1).reason), 'double-key');

  for (const state of [
    startupState({ ...probe, theme: false, imageError: true }, new Map(), false, 1000),
    startupState({ ...probe, workspace: false }, new Map(), false, 30001),
  ]) {
    await mount();
    await receive({ kind: 'state', state });
    assert.equal(await page.locator('#sandrone-startup').count(), 0, 'failed checks release the modal cover');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Message', 'release restores prior keyboard focus');
    assert.equal(await page.evaluate(() => actions.some(item => item.action === 'enter')), false, 'release never reports successful readiness');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.dreamSkin), 'active', 'release preserves available theme effects');
    await editor.fill('Workspace remains reachable');
    await menu.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    assert.equal(menuActions.at(-1), 'disable', 'native-theme action is keyboard reachable after release');
  }
  await mount();
  await page.clock.fastForward(30000);
  assert.equal(await page.locator('#sandrone-startup').count(), 0, 'missing coordinator replies cannot keep the cover indefinitely');
  await editor.click();
  await menu.click(); await menu.click();

  await mount();
  await receive({ kind: 'state', state: startupState({ ...probe, login: true, workspace: false }, new Map(), false, 1000) });
  await page.getByRole('button', { name: '继续登录', exact: true }).click();
  assert.equal(await page.evaluate(() => actions.at(-1).action), 'login');
  await receive({ kind: 'login' });
  assert.equal(await page.locator('#sandrone-startup').count(), 0);
  await page.evaluate(() => controller.dispose());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, checks: ['service-error-keeps-usable-view', 'ready-manual-keyboard-entry', 'image-failure-and-timeout-release', 'restore-editor-focus', 'native-menu-keyboard-access-after-release', 'release-preserves-theme-without-fake-readiness', 'missing-replies-release', 'login-remains-reachable'] }));
} finally { await browser.close(); }

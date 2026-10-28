import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startIntegration } = require('../native-integration/runtime/integration.cjs');
const { installStartupScreen } = require('../native-integration/runtime/startup-preload.cjs');
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sandrone-early-browser-'));
let browser, win;
try {
  const theme = path.join(temporary, 'theme');
  for (const name of ['engine', 'vendor', 'themes', 'assets']) await fs.cp(path.join(root, name), path.join(theme, name), { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<html><body><div class="startup-loader">Official startup</div></body></html>');
  const ipcMain = new EventEmitter(), app = new EventEmitter(), registrations = [], logs = [], replies = [];
  app.getPath = () => path.join(temporary, 'user-data'); app.isReady = () => true; app.whenReady = async () => {};
  class WebContents extends EventEmitter {
    id = 20; mainFrame = { url: 'app://-/index.html' };
    isDestroyed() { return win.destroyed; } isLoading() { return false; } getURL() { return this.mainFrame.url; }
    executeJavaScript(expression) { return page.evaluate(expression); }
    send(channel, message) { if (message.kind === 'bootstrap') { replies.push(message); return; } void page.evaluate(value => window.controller?.receive(value), message).catch(error => { if (!win.destroyed) logs.push(error.message); }); }
  }
  class Window extends EventEmitter {
    id = 1; destroyed = false; webContents = new WebContents();
    isDestroyed() { return this.destroyed; } close() { this.destroyed = true; this.emit('closed'); }
  }
  win = new Window();
  const integration = startIntegration({ app, ipcMain, session: { defaultSession: { registerPreloadScript: script => registrations.push(script) } }, BrowserWindow: { getAllWindows: () => [win] }, dialog: {} }, temporary, { addonPackageFullName: 'fixture' });
  const { manager } = integration;
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  Object.defineProperty(event, 'returnValue', { set: () => assert.fail('bootstrap must not block renderer IPC') });
  ipcMain.emit('sandrone:startup-bootstrap', event);
  const config = replies[0]?.config;
  assert.ok(config?.token, 'asynchronous reply must initialize the player');
  assert.equal(replies.length, 1);
  assert.equal(registrations.length, 1);
  await page.exposeFunction('startupSend', message => ipcMain.emit('sandrone:startup-action', event, message));
  await page.evaluate(`window.controller=(${installStartupScreen.toString()})(${JSON.stringify(config)},(action,detail={})=>window.startupSend({action,...detail,token:${JSON.stringify(config.token)}}));`);
  assert.equal(await page.locator('#sandrone-startup').count(), 1);
  await page.waitForSelector('#sandrone-native-controls');
  await manager.dispatch('auto-enter');
  await page.evaluate(() => {
    document.body.innerHTML = '<aside class="app-shell-left-panel"><button>New chat</button></aside><main class="main-surface" data-app-shell-main-surface><div role="main"><form><textarea aria-label="Message" style="width:600px;height:90px"></textarea></form></div></main>';
  });
  await page.waitForFunction(() => document.documentElement.dataset.dreamSkin === 'active');
  await manager.queue;
  await page.waitForFunction(() => document.getElementById('sandrone-startup')?.dataset.ready === 'true');
  assert.equal(await page.locator('#sandrone-startup').getAttribute('data-service-status'), 'unknown');
  await page.locator('#sandrone-startup .screen').dblclick();
  await page.waitForFunction(() => !document.getElementById('sandrone-startup'));
  await manager.dispatch('replay', win);
  await page.waitForFunction(() => document.getElementById('sandrone-startup')?.dataset.ready === 'true');
  await manager.dispatch('disable', win);
  await page.waitForFunction(() => !document.getElementById('sandrone-startup'));
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-dream-skin')), false);
  await manager.dispatch('enable', win); await manager.dispatch('replay', win);
  await page.waitForFunction(() => document.getElementById('sandrone-startup')?.dataset.ready === 'true');
  const preferences = JSON.parse(await fs.readFile(path.join(temporary, 'user-data/sandrone-theme/settings.json')));
  assert.equal(preferences.autoEnterOnReady, false);
  assert.deepEqual(errors, []); assert.deepEqual(logs, []);
  assert.equal(manager.error, '');
  const events = (await fs.readFile(path.join(integration.dataRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(event => event.event === 'runtime-loaded').addonPackageFullName, 'fixture');
  console.log(JSON.stringify({ pass: true, scope: 'real native integration and Chromium; Electron IPC adapter, not packaged activation', checks: ['async-bootstrap', 'early-overlay-before-shell', 'controls-before-shell', 'actual-theme-installation', 'view-readiness-without-service-messages', 'entry-and-replay', 'disable-cancellation', 'enable-recovery', 'persistent-manual-mode', 'runtime-loaded-identity'] }));
} finally {
  win?.close(); await browser?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}

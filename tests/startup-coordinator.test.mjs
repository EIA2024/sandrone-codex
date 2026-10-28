import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createStartup } = require('../native-integration/runtime/startup.cjs');
const pause = () => new Promise(resolve => setImmediate(resolve));

test('pre-ready startup defers the Electron session getter until ready', async () => {
  let ready = false, release, accesses = 0;
  const registrations = [], logs = [];
  const electron = {
    ipcMain: new EventEmitter(),
    app: { isReady: () => ready, whenReady: () => new Promise(resolve => { release = resolve; }) },
    session: { get defaultSession() {
      accesses++;
      if (!ready) throw new Error('Session unavailable before ready');
      return { registerPreloadScript: value => registrations.push(value) };
    } },
  };
  const coordinator = createStartup(electron, { themeRoot: path.resolve(import.meta.dirname, '..'), log: (...values) => logs.push(values) });
  assert.ok(coordinator);
  assert.equal(accesses, 0);
  ready = true; release(); await pause();
  assert.equal(accesses, 1);
  assert.equal(registrations.length, 1);
  assert.equal(logs.some(([event]) => event.endsWith('-error')), false);
});

function fixture() {
  const ipcMain = new EventEmitter(), messages = [], logs = [], registrations = [];
  let preferences = { enabled: true, openingOnLaunch: true, autoEnterOnReady: true };
  let result = { workspace: true, structure: true, theme: true };
  const frame = { url: 'app://-/index.html' };
  const wc = { id: 1, mainFrame: frame, isDestroyed: () => false, send: (channel, value) => messages.push(value), executeJavaScript: async () => result };
  const electron = { ipcMain, app: { isReady: () => true }, session: { defaultSession: { registerPreloadScript: value => registrations.push(value) } } };
  const coordinator = createStartup(electron, { themeRoot: path.resolve(import.meta.dirname, '..'), preferences: () => preferences, log: (...values) => logs.push(values), disable: async () => { preferences.enabled = false; coordinator.update(preferences); }, retry() {} });
  const event = { sender: wc, senderFrame: frame };
  Object.defineProperty(event, 'returnValue', { set: () => assert.fail('bootstrap must not use synchronous IPC') });
  ipcMain.emit('sandrone:startup-bootstrap', event);
  const replies = messages.splice(0);
  const config = replies[0]?.config;
  const action = (action, values = {}, token = config.token) => ipcMain.emit('sandrone:startup-action', event, { action, token, ...values });
  return { coordinator, event, config, replies, action, messages, logs, registrations, wc, ipcMain, setResult: value => result = value };
}

test('one asynchronous bootstrap reply initializes the startup player', () => {
  const f = fixture();
  assert.ok(f.config?.token, 'renderer must receive a usable configuration');
  assert.equal(f.config.show, true);
  assert.equal(f.replies.length, 1, 'one request must produce one reply');
  assert.equal(f.replies[0].kind, 'bootstrap');
  f.coordinator.replay({ webContents: f.wc });
  assert.deepEqual(f.messages.at(-1), { kind: 'replay', token: f.config.token });
});

test('registers an early preload and grants entry after fresh view probes without private service messages', async () => {
  const f = fixture();
  assert.equal(f.registrations.length, 1); assert.equal(f.config.show, true);
  assert.equal(f.logs.some(([event]) => event.endsWith('-error')), false);
  assert.match(f.config.media.intro, /^app:\/\/fs\/@fs\//);
  f.action('enter', { reason: 'auto' }); await pause();
  assert.equal(f.messages.some(message => message.kind === 'enter'), false);
  f.action('probe'); await pause();
  assert.equal(f.messages.at(-1).state.serviceStatus, 'unknown');
  f.action('enter', { reason: 'auto' }); await pause();
  assert.equal(f.messages.at(-1).kind, 'enter');
  f.messages.length = 0;
  f.setResult({ workspace: true, structure: true, theme: false });
  f.action('enter', { reason: 'double-click' }); await pause();
  assert.equal(f.messages.some(message => message.kind === 'enter'), false);
});

test('navigation and frame boundaries reject stale and foreign commands', async () => {
  const f = fixture();
  f.action('native', {}, 'wrong-token'); await pause();
  assert.equal(f.messages.length, 0);
  const foreign = { sender: f.wc, senderFrame: { url: 'app://-/index.html' } };
  f.ipcMain.emit('sandrone:startup-bootstrap', foreign);
  assert.equal(foreign.returnValue, undefined);
  f.coordinator.invalidate({ webContents: f.wc });
  f.action('native'); await pause();
  assert.equal(f.messages.length, 0);
});

test('a broken host probe releases the screen and replay can recover', async () => {
  const f = fixture();
  const inspect = f.wc.executeJavaScript;
  f.wc.executeJavaScript = async () => { throw new Error('changed host DOM'); };
  f.action('probe'); await pause();
  assert.equal(f.messages.at(-1).kind, 'degraded');
  assert.equal(f.messages.at(-1).reason, 'host-probe-error');
  f.wc.executeJavaScript = inspect;
  f.coordinator.replay({ webContents: f.wc });
  f.action('probe'); await pause();
  f.action('enter', { reason: 'auto' }); await pause();
  assert.equal(f.messages.at(-1).kind, 'enter');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createStartup } = require('../native-integration/runtime/startup.cjs');
const pause = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const ipcMain = new EventEmitter(), messages = [], logs = [], registrations = [];
  let preferences = { enabled: true, openingOnLaunch: true, autoEnterOnReady: true };
  let result = { workspace: true, structure: true, theme: true };
  const frame = { url: 'app://-/index.html' };
  const wc = { id: 1, mainFrame: frame, isDestroyed: () => false, send: (channel, value) => messages.push(value), executeJavaScript: async () => result };
  const electron = { ipcMain, app: { isReady: () => true }, session: { defaultSession: { registerPreloadScript: value => registrations.push(value) } } };
  const coordinator = createStartup(electron, { themeRoot: path.resolve(import.meta.dirname, '..'), preferences: () => preferences, log: (...values) => logs.push(values), disable: async () => { preferences.enabled = false; coordinator.update(preferences); }, retry() {} });
  const event = { sender: wc, senderFrame: frame };
  ipcMain.emit('sandrone:startup-bootstrap', event);
  const action = (action, values = {}, token = event.returnValue.token) => ipcMain.emit('sandrone:startup-action', event, { action, token, ...values });
  return { coordinator, event, action, messages, logs, registrations, wc, ipcMain, setResult: value => result = value };
}

test('registers an early preload and grants entry only after verified lifecycle and fresh probes', async () => {
  const f = fixture();
  assert.equal(f.registrations.length, 1); assert.equal(f.event.returnValue.show, true);
  assert.equal(f.logs.some(([event]) => event.endsWith('-error')), false);
  assert.match(f.event.returnValue.media.intro, /^app:\/\/fs\/@fs\//);
  f.action('enter', { reason: 'auto' }); await pause();
  assert.equal(f.messages.some(message => message.kind === 'enter'), false);
  f.action('host', { type: 'codex-app-server-initialized', hostId: 'local' });
  f.action('host', { type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected' });
  f.action('probe'); await pause();
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
  assert.equal(foreign.returnValue, null);
  f.coordinator.invalidate({ webContents: f.wc });
  f.action('native'); await pause();
  assert.equal(f.messages.length, 0);
});

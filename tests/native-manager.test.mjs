import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ThemeManager } = require('../native-integration/runtime/manager.cjs');
const { readPreferences, writePreferences } = require('../native-integration/runtime/preferences.cjs');
const { isShellUrl, readAction } = require('../native-integration/runtime/boundary.cjs');

function fixture(overrides = {}) {
  const events = [];
  const operations = {
    applyAll: async enabled => { events.push(['apply', enabled]); },
    save: async state => { events.push(['save', { ...state }]); },
    replay: async window => { events.push(['replay', window]); },
    updateControls: async state => { events.push(['controls', { ...state }]); },
    confirmUninstall: async () => true,
    manage: async action => { events.push(['manage', action]); return { status: action === 'Schedule' ? 'scheduled' : 'cancelled' }; },
    ...overrides,
  };
  return { events, manager: new ThemeManager({ schema: 1, enabled: true, openingOnLaunch: true }, operations) };
}

test('ordinary enable/disable persists only after applying the selection', async () => {
  const { events, manager } = fixture();
  await manager.dispatch('disable');
  assert.deepEqual(events.map(event => event[0]), ['apply', 'save', 'controls']);
  assert.equal(manager.snapshot().enabled, false);
  await manager.dispatch('replay', 1);
  assert.equal(events.filter(event => event[0] === 'replay').length, 0);
  await manager.dispatch('enable');
  assert.equal(manager.snapshot().enabled, true);
});

test('partial application failure disables all windows and does not poison the queue', async () => {
  const applied = [];
  const { manager } = fixture({ applyAll: async enabled => {
    applied.push(enabled);
    if (enabled) throw new Error('second window rejected the theme');
  } });
  await assert.rejects(manager.dispatch('enable'), /second window/);
  assert.deepEqual(applied, [true, false]);
  assert.equal(manager.snapshot().enabled, false);
  assert.match(manager.snapshot().error, /second window/);
  await manager.dispatch('disable');
  assert.equal(manager.snapshot().error, '');
});

test('concurrent requests are applied in order across windows', async () => {
  let finishFirst;
  const applied = [];
  const { manager } = fixture({ applyAll: async enabled => {
    applied.push(enabled);
    if (!enabled) await new Promise(resolve => { finishFirst = resolve; });
  } });
  const first = manager.dispatch('disable');
  const second = manager.dispatch('enable');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, [false]);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(applied, [false, true]);
});

test('declining the native uninstall confirmation changes neither theme nor package', async () => {
  const { events, manager } = fixture({ confirmUninstall: async () => false });
  assert.equal(await manager.dispatch('uninstall'), false);
  assert.equal(manager.snapshot().enabled, true);
  assert.deepEqual(events.map(event => event[0]), ['controls']);
});

test('uninstall is scheduled only after cleanup; cancellation does not enable the theme', async () => {
  const { events, manager } = fixture();
  await manager.dispatch('uninstall');
  assert.deepEqual(events.slice(0, 3).map(event => event[0]), ['apply', 'save', 'manage']);
  assert.equal(manager.snapshot().uninstallStatus, 'scheduled');
  await assert.rejects(manager.dispatch('enable'), /取消/);
  await manager.dispatch('cancel-uninstall');
  assert.equal(manager.snapshot().uninstallStatus, 'cancelled');
  assert.equal(manager.snapshot().enabled, false);
  await manager.dispatch('enable');
  assert.equal(manager.snapshot().enabled, true);
});

test('cleanup failure prevents any uninstall request', async () => {
  const { events, manager } = fixture({ applyAll: async () => { throw new Error('cleanup failed'); } });
  await assert.rejects(manager.dispatch('uninstall'), /cleanup failed/);
  assert.equal(events.some(event => event[0] === 'manage'), false);
});

test('uninstall helper failure remains visible, without claiming removal', async () => {
  const { manager } = fixture({ manage: async () => { throw new Error('worker could not start'); } });
  await assert.rejects(manager.dispatch('uninstall'), /worker could not start/);
  assert.equal(manager.snapshot().uninstallStatus, 'idle');
  assert.equal(manager.snapshot().enabled, false);
  assert.match(manager.snapshot().error, /worker could not start/);
});

test('opening preference write failure preserves the previous choice', async () => {
  const { manager } = fixture({ save: async () => { throw new Error('disk is full'); } });
  await assert.rejects(manager.dispatch('opening'), /disk is full/);
  assert.equal(manager.snapshot().openingOnLaunch, true);
});

test('only explicit actions from the current main frame are accepted', () => {
  const frame = {};
  const prefix = '__SANDRONE_NATIVE_test:';
  assert.equal(readAction({ frame, message: prefix + 'disable' }, frame, prefix), 'disable');
  assert.equal(readAction({ frame: {}, message: prefix + 'uninstall' }, frame, prefix), null);
  assert.equal(readAction({ message: prefix + 'uninstall' }, frame, prefix), null);
  assert.equal(readAction({ frame, message: 'old-prefix:disable' }, frame, prefix), null);
  assert.equal(readAction({ frame, message: prefix + 'uninstall; command' }, frame, prefix), null);
});

test('only official app URLs are eligible; pet and external windows are excluded', () => {
  assert.equal(isShellUrl('app://-/index.html'), true);
  assert.equal(isShellUrl('https://example.com/index.html'), false);
  assert.equal(isShellUrl('app://untrusted/index.html'), false);
  assert.equal(isShellUrl('app://-/avatar-overlay-composition-surface.html'), false);
  assert.equal(isShellUrl('app://-/index.html?initialRoute=%2Favatar-overlay%2Fmini'), false);
});

test('preferences survive a process reload and ignore malformed/unrelated fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandrone-preferences-'));
  try {
    writePreferences(directory, { enabled: false, openingOnLaunch: false, secret: 'not written' });
    assert.deepEqual(readPreferences(directory), { schema: 1, enabled: false, openingOnLaunch: false });
    const saved = fs.readFileSync(path.join(directory, 'settings.json'), 'utf8');
    assert.equal(saved.includes('secret'), false);
    fs.writeFileSync(path.join(directory, 'settings.json'), '{ broken');
    assert.deepEqual(readPreferences(directory), { schema: 1, enabled: true, openingOnLaunch: true });
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ schema: 1, enabled: 'false', openingOnLaunch: [] }));
    assert.equal(readPreferences(directory).enabled, true);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sandrone-preferences-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('opening the menu preserves an earlier action failure until the next action', async () => {
  const { manager } = fixture({ replay: async () => { throw new Error('media failed'); } });
  await assert.rejects(manager.dispatch('replay'), /media failed/);
  await manager.dispatch('status');
  assert.equal(manager.snapshot().error, 'media failed');
  await manager.dispatch('disable');
  assert.equal(manager.snapshot().error, '');
});

test('late SPA shell readiness survives the startup grace period and backs off', async () => {
  const { waitForShell } = require('../native-integration/runtime/integration.cjs');
  let probes = 0;
  const waits = [];
  assert.equal(await waitForShell(() => ++probes === 85, () => true, async ms => waits.push(ms)), true);
  assert.equal(probes, 85);
  assert.ok(waits.includes(1000));
  let current = true;
  assert.equal(await waitForShell(() => false, () => current, async () => { current = false; }), false);
});


test('a failed uninstall worker unlocks the menu for recovery', async () => {
  const { manager } = fixture({ manage: async action => action === 'Schedule'
    ? { status: 'scheduled' } : { status: 'error', error: 'WORKER_STOPPED' } });
  await manager.dispatch('uninstall');
  await assert.rejects(manager.dispatch('status'), /WORKER_STOPPED/);
  assert.equal(manager.snapshot().uninstallStatus, 'error');
  await manager.dispatch('enable');
  assert.equal(manager.snapshot().enabled, true);
  await manager.dispatch('uninstall');
  assert.equal(manager.snapshot().uninstallStatus, 'scheduled');
});

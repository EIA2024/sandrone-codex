import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { updateHost, startupState } = require('../native-integration/runtime/startup-readiness.cjs');
const { readPreferences, writePreferences } = require('../native-integration/runtime/preferences.cjs');
const good = { workspace: true, structure: true, theme: true };
const initialized = (hosts, id = 'local') => {
  updateHost(hosts, { type: 'codex-app-server-initialized', hostId: id });
  updateHost(hosts, { type: 'codex-app-server-connection-changed', hostId: id, state: 'connected' });
};

test('only observed view checks grant entry; optional service evidence is reported separately', () => {
  const hosts = new Map();
  assert.deepEqual(startupState({}, hosts, false, 120000).steps, [true, false, false, false, false]);
  initialized(hosts, 'unrelated-remote');
  assert.equal(startupState(good, hosts, true, 0).ready, true);
  assert.equal(startupState(good, hosts, true, 0).serviceStatus, 'unknown');
  initialized(hosts);
  assert.equal(startupState(good, hosts, false, 0).ready, false);
  for (const key of ['workspace', 'structure', 'theme']) assert.equal(startupState({ ...good, [key]: false }, hosts, true, 0).ready, false);
  assert.equal(startupState(good, hosts, true, 0).ready, true);
});

test('service disconnect does not block a usable view; reconnect still requires initialization for service status', () => {
  const hosts = new Map(); initialized(hosts);
  updateHost(hosts, { type: 'codex-app-server-connection-changed', hostId: 'local', state: 'error' });
  assert.equal(startupState(good, hosts, true, 0).ready, true);
  assert.equal(startupState(good, hosts, true, 0).serviceStatus, 'error');
  updateHost(hosts, { type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected' });
  assert.equal(startupState(good, hosts, true, 0).serviceStatus, 'disconnected');
  initialized(hosts); assert.equal(startupState(good, hosts, true, 0).serviceStatus, 'connected');
});

test('timeout and broken images degrade without falsely completing readiness', () => {
  assert.equal(startupState({}, new Map(), false, 29999).degraded, false);
  const timedOut = startupState({}, new Map(), false, 30000);
  assert.equal(timedOut.degraded, true);
  assert.equal(timedOut.ready, false);
  assert.equal(startupState(good, new Map(), true, 60000).degraded, false);
  assert.equal(startupState({ ...good, theme: false, imageError: true }, new Map(), false, 0).degraded, true);
});

test('legacy preferences migrate by default and manual mode persists', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandrone-startup-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ schema: 1, enabled: true, openingOnLaunch: true }));
    assert.equal(readPreferences(directory).autoEnterOnReady, true);
    writePreferences(directory, { ...readPreferences(directory), autoEnterOnReady: false });
    assert.equal(readPreferences(directory).autoEnterOnReady, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

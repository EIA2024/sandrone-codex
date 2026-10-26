const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { ThemeManager } = require('./manager.cjs');
const { readPreferences, writePreferences } = require('./preferences.cjs');
const { isShellUrl, readAction } = require('./boundary.cjs');
const { installControls } = require('./controls.cjs');
const { createManagement } = require('./management.cjs');

const call = (fn, ...args) => `(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shellProbe = `Boolean(document.querySelector('aside.app-shell-left-panel') && document.querySelector('main:is(.main-surface, [data-app-shell-main-surface], [class*="_MainContentSurface_"])'))`;

// The shell may appear long after did-finish-load (login or slow startup).
// Back off after the first 20 seconds and stop on navigation/window closure.
async function waitForShell(probe, current, pause = delay) {
  for (let attempt = 0; current(); attempt++) {
    let ready = false;
    try { ready = await probe(); } catch {}
    if (!current()) return false;
    if (ready) return true;
    await pause(attempt < 80 ? 250 : 1000);
  }
  return false;
}

function startIntegration(electron, installationRoot, installation) {
  const { app, BrowserWindow, dialog } = electron;
  const themeRoot = path.join(installationRoot, 'theme');
  const dataRoot = path.join(app.getPath('userData'), 'sandrone-theme');
  fs.mkdirSync(dataRoot, { recursive: true });
  const logFile = path.join(dataRoot, 'events.jsonl');
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
    fs.renameSync(logFile, logFile + '.previous');
  }
  const log = (event, error) => {
    try { fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), event, message: error?.message }) + '\n'); } catch {}
  };
  const windows = new Map();
  let startupOpeningShown = false;
  let modulesPromise, skinPromise, assetsPromise;
  const load = relative => import(pathToFileURL(path.join(themeRoot, relative)).href);
  const modules = () => modulesPromise ??= Promise.all([
    load('vendor/dream-skin/windows/scripts/injector.mjs'), load('engine/renderer.mjs'),
    fs.existsSync(path.join(themeRoot, 'engine/opening-client.mjs')) ? load('engine/opening-client.mjs') : null,
  ]).then(([injector, renderer, openingClient]) => ({ injector, renderer, openingClient }));
  const skin = () => skinPromise ??= modules().then(async ({ injector }) => ({
    loaded: await injector.loadPayload(path.join(themeRoot, 'themes/sandrone')),
    css: await fs.promises.readFile(path.join(themeRoot, 'engine/native-ui.css'), 'utf8'),
  })).catch(error => { skinPromise = null; throw error; });
  const assets = () => assetsPromise ??= load('engine/assets.mjs').then(module => module.openingAssets())
    .catch(error => { assetsPromise = null; throw error; });

  const alive = win => !win.isDestroyed() && !win.webContents.isDestroyed() && isShellUrl(win.webContents.getURL());
  const eligible = win => windows.get(win.id)?.eligible && alive(win);
  const all = () => [...windows.values()].filter(entry => eligible(entry.win));
  const evaluate = (entry, generation = entry.generation) => {
    if (entry.evaluator?.generation === generation) return entry.evaluator.run;
    const run = async expression => {
      if (!eligible(entry.win) || entry.generation !== generation) {
        const error = new Error('Theme window changed');
        error.code = 'SANDRONE_WINDOW_CHANGED';
        throw error;
      }
      return entry.win.webContents.executeJavaScript(expression);
    };
    entry.evaluator = { generation, run };
    return run;
  };
  const manage = createManagement(installationRoot, dataRoot, installation);
  const manager = new ThemeManager(readPreferences(dataRoot), {
    save: async preferences => writePreferences(dataRoot, preferences),
    applyAll: async enabled => {
      const results = await Promise.allSettled(all().map(entry => apply(entry, enabled)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
    replay: async win => { if (eligible(win)) await play(windows.get(win.id), true); },
    updateControls: async state => {
      await Promise.allSettled(all().map(entry => evaluate(entry)(call(installControls, entry.prefix, state))));
    },
    confirmUninstall: async win => {
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: '卸载桑多涅主题附加包',
        message: '在退出 Codex 后卸载主题附加包？',
        detail: '现在切回原生界面。保存工作并退出所有 Codex 窗口及托盘进程后，自动移除附加包。不会删除聊天、主题偏好或原有启动器。退出前可在主题菜单取消。',
        buttons: ['取消', '退出后卸载'], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1;
    },
    manage,
  });

  async function release(entry) {
    entry.generation++;
    const generation = entry.generation;
    if (!eligible(entry.win)) return;
    const { renderer, openingClient } = await modules();
    if (!eligible(entry.win) || entry.generation !== generation) return;
    const run = evaluate(entry, generation);
    if (openingClient) await openingClient.releaseOpening(run);
    await run(call(renderer.removeNativeUi));
  }

  async function apply(entry, enabled) {
    if (!eligible(entry.win)) return;
    const generation = entry.generation;
    const { injector, renderer } = await modules();
    if (!enabled) {
      await release(entry);
      if (!eligible(entry.win)) return;
      if (!await injector.cleanupExcludedSurface({ evaluate: evaluate(entry) })) {
        throw new Error('主题清理未通过检查，请退出并重开 Codex。');
      }
      return;
    }
    const { loaded, css } = await skin();
    if (!eligible(entry.win) || generation !== entry.generation || !manager.preferences.enabled) return;
    const run = evaluate(entry, generation);
    await run('window.__CODEX_DREAM_SKIN_DISABLED__ = false');
    await run(loaded.payload);
    await run(call(renderer.installNativeUi, css));
    await run(call(renderer.setStartupPhase, 'ready'));
  }

  async function play(entry, replay = false) {
    const generation = entry.generation;
    const valid = () => eligible(entry.win) && generation === entry.generation && manager.preferences.enabled;
    const [{ renderer, openingClient }, openingAssets] = await Promise.all([modules(), assets()]);
    if (!valid()) return;
    // Keep one evaluator per document generation so the shared opening client
    // can deduplicate preparation and reuse the renderer cache on replay.
    const guardedEvaluate = evaluate(entry, generation);
    if (openingClient) await openingClient.showOpening(guardedEvaluate, openingAssets, { replay });
    else await guardedEvaluate(call(renderer.showOpening, openingAssets, { replay }));
  }

  function invalidate(entry) {
    entry.generation++;
    entry.eligible = false;
    entry.prefix = `__SANDRONE_NATIVE_${crypto.randomUUID()}:`;
  }

  async function loaded(entry) {
    invalidate(entry);
    const generation = entry.generation;
    const ready = await waitForShell(
      () => entry.win.webContents.executeJavaScript(shellProbe),
      () => alive(entry.win) && entry.generation === generation,
    );
    if (ready) {
      entry.eligible = true;
      return manager.enqueue(async () => {
        if (!eligible(entry.win) || entry.generation !== generation) return;
        await evaluate(entry, generation)(call(installControls, entry.prefix, manager.snapshot()));
        try {
          await apply(entry, manager.preferences.enabled);
          if (entry.generation === generation && manager.preferences.enabled && manager.preferences.openingOnLaunch && !startupOpeningShown) {
            startupOpeningShown = true;
            await play(entry);
          }
        } catch (error) {
          // Keep the app usable and the management controls reachable even
          // when an optional visual component is unavailable.
          if (error.code === 'SANDRONE_WINDOW_CHANGED' || entry.generation !== generation) return;
          manager.error = '主题加载失败，可切回原生界面或卸载。';
          log('theme-load-error', error);
        }
        await manager.operations.updateControls(manager.snapshot());
      });
    }
  }

  function attach(win) {
    if (windows.has(win.id)) return;
    const entry = { win, eligible: false, generation: 0, prefix: '' };
    windows.set(win.id, entry);
    win.webContents.on('console-message', details => {
      if (!eligible(win)) return;
      const action = readAction(details, win.webContents.mainFrame, entry.prefix);
      if (!action) return;
      if (action === 'disable') {
        // Cancel preparation before the queued preference change, so a slow
        // first media decode cannot hold the user's disable request hostage.
        void release(entry).catch(error => {
          if (error.code !== 'SANDRONE_WINDOW_CHANGED') log('opening-cancel-error', error);
        });
      }
      void manager.dispatch(action, win).catch(error => log('action-error', error));
    });
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) invalidate(entry);
    });
    win.webContents.on('did-finish-load', () => { void loaded(entry).catch(error => log('window-error', error)); });
    win.on('closed', () => { invalidate(entry); windows.delete(win.id); });
    if (!win.webContents.isLoading()) void loaded(entry).catch(error => log('window-error', error));
  }

  // A queued uninstall must survive a restart without applying the theme
  // again. Reading its receipt avoids spawning PowerShell on every startup.
  try {
    const request = JSON.parse(fs.readFileSync(path.join(dataRoot, 'uninstall-request.json'), 'utf8'));
    if (request.schema === 1 && request.packageFullName === installation.addonPackageFullName &&
        ['scheduled', 'removing'].includes(request.status) && Date.parse(request.expiresAt) > Date.now()) {
      manager.uninstallStatus = request.status;
      manager.preferences.enabled = false;
    }
  } catch {}
  app.on('browser-window-created', (_event, win) => attach(win));
  // Settings stay in Codex userData; the plugin package is immutable and
  // uninstall preserves these preferences for a subsequent reinstall.
  app.whenReady().then(() => {
    for (const win of BrowserWindow.getAllWindows()) attach(win);
  }).catch(error => log('ready-error', error));
  return { manager, dataRoot };
}

module.exports = { startIntegration, waitForShell };

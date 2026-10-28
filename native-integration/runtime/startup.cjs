const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectWorkspace, updateHost, startupState } = require('./startup-readiness.cjs');
const { hostContract, isShellUrl, mediaUrl } = require('./host-adapter.cjs');

function startupMedia(themeRoot) {
  const root = path.join(themeRoot, 'assets/motion');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'startup.json'), 'utf8'));
  const url = name => {
    if (!/^sandrone-startup-(intro|idle|poster)\.(mp4|jpg)$/.test(name)) throw new Error('Invalid startup media name');
    const file = path.join(root, name);
    if (!fs.statSync(file).isFile()) throw new Error('Missing startup media');
    return mediaUrl(file);
  };
  const poster = fs.readFileSync(path.join(root, 'sandrone-startup-poster.jpg'));
  if (poster.length > 512 * 1024 || poster[0] !== 255 || poster[1] !== 216) throw new Error('Invalid startup poster');
  const still = fs.readFileSync(path.join(root, 'sandrone-startup-still.jpg'));
  if (still.length > 512 * 1024 || still[0] !== 255 || still[1] !== 216) throw new Error('Invalid startup still');
  return { intro: url(manifest.intro.file), loop: url(manifest.idle.file), poster: 'data:image/jpeg;base64,' + poster.toString('base64'), still: 'data:image/jpeg;base64,' + still.toString('base64') };
}

function createStartup(electron, options) {
  const { ipcMain, session, app } = electron;
  if (!ipcMain || !session) return null;
  const documents = new Map(), themes = new Map();
  let shown = false, media;
  try { media = startupMedia(options.themeRoot); }
  catch (error) { options.log('startup-media-error', error); media = { intro: null, loop: null, poster: '', error: true }; }
  const allowed = event => !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame && isShellUrl(event.senderFrame.url);
  const send = (document, message) => {
    if (documents.get(document.wc.id) === document && !document.wc.isDestroyed()) document.wc.send('sandrone:startup-state', { ...message, token: document.token });
  };
  const degrade = (document, reason) => {
    if (document.degraded) return;
    document.degraded = true;
    options.log('startup-degraded', { message: reason });
    options.onDegraded?.(document.wc, reason);
    send(document, { kind: 'degraded', reason });
  };
  const inspect = document => document.wc.executeJavaScript(`(${inspectWorkspace.toString()})(${JSON.stringify(document.expected)},${JSON.stringify(hostContract)})`);
  async function probe(document, entering) {
    if (document.busy || document.degraded) return;
    document.busy = true;
    try {
      const result = await inspect(document);
      if (documents.get(document.wc.id) !== document) return;
      const candidate = startupState(result, document.hosts, true, Date.now() - document.started);
      const settled = candidate.ready && document.candidate;
      document.candidate = candidate.ready;
      const state = startupState(result, document.hosts, settled, Date.now() - document.started);
      const progressKey = state.steps.map(Number).join('');
      if (document.progressKey !== progressKey) { document.progressKey = progressKey; options.log('startup-progress-' + progressKey); }
      if (state.degraded) { degrade(document, result.imageError ? 'theme-image-error' : 'readiness-unconfirmed'); return; }
      if (state.ready && entering) {
        await document.wc.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        if (documents.get(document.wc.id) !== document) return;
        const fresh = await inspect(document);
        if (documents.get(document.wc.id) !== document) return;
        const confirmed = startupState(fresh, document.hosts, true, Date.now() - document.started);
        send(document, { kind: 'state', state: confirmed });
        if (confirmed.degraded) { degrade(document, 'readiness-unconfirmed'); return; }
        if (confirmed.ready && options.preferences().enabled && (entering !== 'auto' || options.preferences().autoEnterOnReady)) send(document, { kind: 'enter', reason: entering });
      } else send(document, { kind: 'state', state });
    } catch (error) {
      if (documents.get(document.wc.id) === document) degrade(document, 'host-probe-error');
    } finally { document.busy = false; }
  }
  // Bootstrap is asynchronous: a missing main-process reply must never freeze
  // the renderer before its independent fail-open timer can run.
  ipcMain.on('sandrone:startup-bootstrap', event => {
    if (!allowed(event)) return;
    const preferences = options.preferences();
    const document = { wc: event.sender, token: crypto.randomUUID(), hosts: new Map(), expected: themes.get(event.sender.id) || null, started: Date.now(), busy: false, candidate: false, degraded: false };
    documents.set(event.sender.id, document);
    const show = preferences.enabled && preferences.openingOnLaunch && !shown;
    if (show) shown = true;
    if (show) options.log('startup-document-created');
    send(document, { kind: 'bootstrap', config: { token: document.token, preferences, show, media, host: hostContract } });
  });
  ipcMain.on('sandrone:startup-action', (event, message) => {
    if (!allowed(event)) return;
    const document = documents.get(event.sender.id);
    if (!document || message?.token !== document.token) return;
    if (message.action === 'milestone' && ['screen-mounted', 'first-video-frame', 'intro-ended', 'entered'].includes(message.name)) { options.log('startup-' + message.name); return; }
    if (message.action === 'degraded' && ['readiness-timeout', 'media-error', 'media-timeout', 'host-incompatible'].includes(message.reason)) { degrade(document, message.reason); return; }
    if (message.action === 'host') { updateHost(document.hosts, message); return; }
    if (message.action === 'probe' || message.action === 'retry') {
      if (message.action === 'retry') {
        document.candidate = false;
        void document.wc.executeJavaScript('delete window.__SANDRONE_READINESS_IMAGES__').then(() => options.retry(event.sender)).catch(error => options.log('startup-retry-error', error));
      }
      void probe(document); return;
    }
    if (message.action === 'enter' && ['auto', 'double-click', 'double-key'].includes(message.reason)) { void probe(document, message.reason); return; }
    if (message.action === 'login') { send(document, { kind: 'login' }); return; }
    if (message.action === 'native') void options.disable().catch(error => options.log('startup-disable-error', error));
  });
  const register = () => {
    // Electron's defaultSession getter is unavailable until app is ready.
    const ses = session.defaultSession;
    if (typeof ses?.registerPreloadScript !== 'function') {
      options.log('startup-preload-unavailable');
      return;
    }
    ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'startup-preload.cjs') });
    options.log('startup-preload-registered');
  };
  if (app.isReady()) {
    try { register(); } catch (error) { options.log('startup-preload-error', error); return null; }
  } else app.whenReady().then(register).catch(error => options.log('startup-preload-error', error));
  return {
    setTheme(win, loaded) {
      themes.set(win.webContents.id, { themeId: loaded.theme.id, revision: loaded.revision });
      const document = documents.get(win.webContents.id);
      if (document) { document.expected = { themeId: loaded.theme.id, revision: loaded.revision }; document.candidate = false; }
    },
    degrade(win, reason = 'host-incompatible') { const document = documents.get(win.webContents.id); if (document) degrade(document, reason); },
    update(preferences) {
      for (const document of documents.values()) {
        if (!preferences.enabled) { document.expected = null; document.candidate = false; }
        send(document, { kind: 'preferences', preferences });
      }
    },
    replay(win) {
      const document = documents.get(win.webContents.id);
      if (document) { document.started = Date.now(); document.candidate = false; document.degraded = false; send(document, { kind: 'replay' }); }
    },
    invalidate(win) { documents.delete(win.webContents.id); themes.delete(win.webContents.id); },
  };
}

module.exports = { createStartup, startupMedia };

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectWorkspace, updateHost, startupState } = require('./startup-readiness.cjs');

function startupMedia(themeRoot) {
  const root = path.join(themeRoot, 'assets/motion');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'startup.json'), 'utf8'));
  const url = name => {
    if (!/^sandrone-startup-(intro|idle|poster)\.(mp4|jpg)$/.test(name)) throw new Error('Invalid startup media name');
    const file = path.join(root, name);
    if (!fs.statSync(file).isFile()) throw new Error('Missing startup media');
    return 'app://fs/@fs/' + encodeURI(file.replaceAll('\\', '/'));
  };
  // A tiny embedded poster can paint before app: starts serving video. Large
  // videos are served as files by the host's existing range-aware media route.
  const poster = fs.readFileSync(path.join(root, 'sandrone-startup-poster.jpg'));
  if (poster.length > 512 * 1024 || poster[0] !== 255 || poster[1] !== 216) throw new Error('Invalid startup poster');
  const still = fs.readFileSync(path.join(root, 'sandrone-startup-still.jpg'));
  if (still.length > 512 * 1024 || still[0] !== 255 || still[1] !== 216) throw new Error('Invalid startup still');
  return { intro: url(manifest.intro.file), loop: url(manifest.idle.file), poster: 'data:image/jpeg;base64,' + poster.toString('base64'), still: 'data:image/jpeg;base64,' + still.toString('base64') };
}

function createStartup(electron, options) {
  const { ipcMain, session, app } = electron;
  // Old browser adapters exercise the portable player separately. Production
  // Electron always has these APIs; absence is recorded rather than calling a
  // late overlay a successful early-startup replacement.
  if (!ipcMain || !session) return null;
  const documents = new Map();
  let shown = false, media;
  try { media = startupMedia(options.themeRoot); }
  catch (error) { options.log('startup-media-error', error); media = { intro: null, loop: null, poster: '' }; }
  const allowed = event => {
    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return false;
    try {
      const url = new URL(event.senderFrame.url);
      return url.protocol === 'app:' && url.hostname === '-' && url.pathname === '/index.html' && !/^\/(avatar-overlay|screen-overlay)(\/|$)/.test(url.searchParams.get('initialRoute') || '');
    } catch { return false; }
  };
  const send = (document, message) => {
    if (documents.get(document.wc.id) === document && !document.wc.isDestroyed()) document.wc.send('sandrone:startup-state', { ...message, token: document.token });
  };
  async function probe(document, entering) {
    if (document.busy) return;
    document.busy = true;
    try {
      const result = await document.wc.executeJavaScript(`(${inspectWorkspace.toString()})(${JSON.stringify(document.expected)})`);
      if (documents.get(document.wc.id) !== document) return;
      const candidate = startupState(result, document.hosts, true, Date.now() - document.started);
      const settled = candidate.ready && document.candidate;
      document.candidate = candidate.ready;
      const state = startupState(result, document.hosts, settled, Date.now() - document.started);
      const progressKey = state.steps.map(Number).join('');
      if (document.progressKey !== progressKey) { document.progressKey = progressKey; options.log('startup-progress-' + progressKey); }
      if (state.ready && entering) {
        // Two renderer frames allow the verified styles and decoded images to
        // reach painting. Recheck afterwards instead of treating elapsed time
        // as proof of readiness.
        await document.wc.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const fresh = await document.wc.executeJavaScript(`(${inspectWorkspace.toString()})(${JSON.stringify(document.expected)})`);
        const confirmed = startupState(fresh, document.hosts, true, Date.now() - document.started);
        send(document, { kind: 'state', state: confirmed });
        if (confirmed.ready && options.preferences().enabled && (entering !== 'auto' || options.preferences().autoEnterOnReady)) send(document, { kind: 'enter', reason: entering });
      } else send(document, { kind: 'state', state });
    } catch (error) {
      if (documents.get(document.wc.id) === document) send(document, { kind: 'state', state: { steps: [true, false, false, false, false], ready: false, status: '工作区检查暂未完成', recovery: true } });
    } finally { document.busy = false; }
  }
  ipcMain.on('sandrone:startup-bootstrap', event => {
    // Setting returnValue sends the synchronous IPC reply immediately. Do not
    // send a placeholder before the configuration: the renderer keeps it.
    if (!allowed(event)) { event.returnValue = null; return; }
    const preferences = options.preferences();
    const document = { wc: event.sender, token: crypto.randomUUID(), hosts: new Map(), expected: null, started: Date.now(), busy: false, candidate: false };
    documents.set(event.sender.id, document);
    const show = preferences.enabled && preferences.openingOnLaunch && !shown;
    if (show) shown = true;
    if (show) options.log('startup-document-created');
    event.returnValue = { token: document.token, preferences, show, media };
  });
  ipcMain.on('sandrone:startup-action', (event, message) => {
    if (!allowed(event)) return;
    const document = documents.get(event.sender.id);
    if (!document || message?.token !== document.token) return;
    if (message.action === 'milestone' && ['screen-mounted', 'first-video-frame', 'intro-ended', 'entered'].includes(message.name)) { options.log('startup-' + message.name); return; }
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
    const ses = session.defaultSession;
    const filePath = path.join(__dirname, 'startup-preload.cjs');
    if (typeof ses.registerPreloadScript !== 'function') throw new Error('Early preload API unavailable in this Codex build');
    ses.registerPreloadScript({ type: 'frame', filePath });
    options.log('startup-preload-registered');
  };
  if (app.isReady()) register(); else app.whenReady().then(register).catch(error => options.log('startup-preload-error', error));
  return {
    setTheme(win, loaded) {
      const document = documents.get(win.webContents.id);
      if (document) { document.expected = { themeId: loaded.theme.id, revision: loaded.revision }; document.candidate = false; }
    },
    update(preferences) {
      for (const document of documents.values()) {
        if (!preferences.enabled) { document.expected = null; document.candidate = false; }
        send(document, { kind: 'preferences', preferences });
      }
    },
    replay(win) { const document = documents.get(win.webContents.id); if (document) send(document, { kind: 'replay' }); },
    invalidate(win) { documents.delete(win.webContents.id); },
  };
}

module.exports = { createStartup, startupMedia };

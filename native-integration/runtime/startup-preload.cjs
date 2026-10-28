// Self-contained: sandboxed Electron preloads cannot require sibling modules.
// This factory is also exercised in an isolated browser by the regression suite.
function installStartupScreen(config, deliver) {
  let host, shadow, video, poll, watchdog, readinessTimer, leaving, previousFocus;
  let disposed = false, introDone = false, requestPending = false, exiting = false, lastSpace = -Infinity;
  let loginObserver;
  let state = { steps: [true, false, false, false, false], ready: false, status: '正在启动页面' };
  let preferences = config.preferences;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  const now = () => performance.now();
  const diagnostics = { mountedAt: null, firstVideoFrameAt: null, introEndedAt: null, enteredAt: null };
  const send = (action, detail) => { try { deliver(action, detail); } catch {} };

  function clearMedia() {
    if (!video) return;
    video.pause(); video.removeAttribute('src'); video.load(); video.remove(); video = null;
    clearTimeout(watchdog);
  }
  function remove() {
    clearInterval(poll); clearTimeout(leaving); clearTimeout(watchdog); clearTimeout(readinessTimer); readinessTimer = null;
    const ownedFocus = host && (document.activeElement === host || host.contains(document.activeElement));
    clearMedia(); host?.remove(); host = shadow = null;
    if (ownedFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  function degrade(reason) {
    diagnostics.degradedReason = reason;
    diagnostics.serviceStatus = state.serviceStatus || 'unknown';
    state.ready = false;
    // Cleanup must not depend on a live coordinator or successful IPC delivery.
    try { send('degraded', { reason }); } catch {} finally { remove(); }
  }
  function armReadinessDeadline() {
    if (readinessTimer || !host) return;
    readinessTimer = setTimeout(() => { readinessTimer = null; if (host && !state.ready) degrade('readiness-timeout'); }, 30000);
  }
  function publish() {
    if (!host) return;
    if (state.degraded) { degrade('host-incompatible'); return; }
    if (state.ready) { clearTimeout(readinessTimer); readinessTimer = null; } else armReadinessDeadline();
    host.dataset.ready = String(state.ready);
    host.dataset.serviceStatus = state.serviceStatus || 'unknown';
    host.dataset.introDone = String(introDone);
    host.dataset.steps = state.steps.map(Number).join('');
    host.dataset.diagnostics = JSON.stringify(diagnostics);
    const count = state.steps.filter(Boolean).length;
    const progress = shadow.querySelector('progress');
    progress.value = count; progress.setAttribute('aria-valuetext', state.status);
    shadow.querySelector('.status').textContent = state.status;
    shadow.querySelector('.hint').textContent = state.ready
      ? preferences.autoEnterOnReady ? introDone ? '正在进入工作区' : '工作区已就绪 · 片头播放后自动进入' : '双击进入 · 或连续按两次空格进入'
      : '正在准备工作区，完成后可以进入';
    shadow.querySelector('.recovery').hidden = !state.login;
    shadow.querySelector('[data-action="login"]').hidden = !state.login;
    if (preferences.autoEnterOnReady && state.ready && introDone) requestEntry('auto');
  }
  function requestEntry(reason) {
    if (!host || !state.ready || requestPending || exiting || (reason === 'auto' && !introDone)) return;
    requestPending = true;
    // The main process performs a fresh readiness check before granting entry.
    send('enter', { reason });
  }
  function fallback() {
    clearMedia(); introDone = true; diagnostics.mediaFallback = true;
    if (shadow) shadow.querySelector('img').src = config.media.still || config.media.poster;
    publish();
  }
  function playLoop() {
    if (!video || !config.media.loop) return fallback();
    video.poster = config.media.still || config.media.poster;
    video.loop = true; video.src = config.media.loop;
    const owner = video; video.play().catch(() => { if (video === owner) degrade('media-error'); });
  }
  function mount(replay = false) {
    if (disposed || host || !preferences.enabled || !document.documentElement) return;
    previousFocus = document.activeElement;
    exiting = false; requestPending = false; lastSpace = -Infinity;
    introDone = reduced.matches || !config.media.intro;
    diagnostics.mountedAt = now(); diagnostics.firstVideoFrameAt = null;
    diagnostics.introEndedAt = null; diagnostics.enteredAt = null;
    host = document.createElement('div'); host.id = 'sandrone-startup';
    host.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;isolation:isolate!important;background:#0b111b!important';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{color:#eee9dc;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
      *{box-sizing:border-box}.screen{position:absolute;inset:0;background:#0b111b;outline:0}
      .art{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
      .bottom{position:absolute;left:5%;right:5%;bottom:6%;max-width:560px;padding:14px 18px;background:#0b111be8;border-left:2px solid #d3b77e}
      .status{font-size:14px;letter-spacing:.08em}.hint{font-size:12px;margin-top:10px;color:#c4b89d}
      progress{display:block;width:100%;height:3px;margin-top:12px;appearance:none;border:0;background:#d3b77e22}
      progress::-webkit-progress-bar{background:#d3b77e22}progress::-webkit-progress-value{background:linear-gradient(90deg,#946641,#ecd399,#a8ddea)}
      .recovery{margin-top:10px}button{color:#eee9dc;background:#263343;border:1px solid #766246;padding:7px 12px;margin:4px;cursor:pointer}
      .screen.fading{opacity:0;transition:opacity .25s ease}.screen.fading *{pointer-events:none}
      [hidden]{display:none!important}
    </style><div class="screen" role="dialog" aria-modal="true" aria-label="桑多涅启动画面" tabindex="0"><img class="art" alt="桑多涅"><div class="bottom"><div class="status" aria-live="polite"></div><progress max="5" value="1" aria-label="启动阶段"></progress><div class="hint"></div><div class="recovery" hidden><button data-action="login" hidden>继续登录</button></div></div></div>`;
    shadow.querySelector('img').src = introDone ? config.media.still || config.media.poster : config.media.poster;
    const screen = shadow.querySelector('.screen');
    screen.addEventListener('dblclick', event => {
      if (event.target.closest('button')) return;
      event.preventDefault(); requestEntry('double-click');
    });
    screen.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        const controls = [...shadow.querySelectorAll('button')].filter(button => !button.hidden && !button.closest('[hidden]'));
        event.preventDefault();
        if (!controls.length) return screen.focus();
        const index = controls.indexOf(shadow.activeElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
      if (event.key !== ' ' || event.repeat || event.target.closest('button')) return;
      event.preventDefault(); const time = now();
      if (time - lastSpace < 500) requestEntry('double-key');
      lastSpace = time;
    });
    shadow.querySelector('.recovery').addEventListener('click', event => {
      const action = event.target.closest('button')?.dataset.action;
      if (action) send(action);
    });
    document.documentElement.appendChild(host); screen.focus({ preventScroll: true });
    send('milestone', { name: 'screen-mounted' });
    armReadinessDeadline();
    if (config.media.error) { degrade('media-error'); return; }
    if (!introDone) {
      video = document.createElement('video'); video.className = 'art';
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      video.setAttribute('aria-hidden', 'true'); video.poster = config.media.poster;
      screen.insertBefore(video, shadow.querySelector('.bottom'));
      const owner = video;
      video.addEventListener('error', () => { if (video === owner) degrade('media-error'); });
      video.addEventListener('ended', () => {
        if (video !== owner || introDone) return;
        introDone = true; diagnostics.introEndedAt = now(); send('milestone', { name: 'intro-ended' }); publish();
        // Keep displaying animation while a slow workspace or a person is waiting.
        if (host) playLoop();
      });
      video.addEventListener('playing', () => {
        if (video !== owner) return;
        clearTimeout(watchdog);
        diagnostics.playbackStartedAt ??= now(); publish();
      });
      for (const event of ['waiting', 'stalled']) video.addEventListener(event, () => {
        if (video !== owner) return;
        clearTimeout(watchdog); watchdog = setTimeout(() => { if (video === owner) degrade('media-timeout'); }, 12000);
      });
      video.src = config.media.intro; video.play().catch(() => { if (video === owner) degrade('media-error'); });
      video.requestVideoFrameCallback?.(() => {
        if (video !== owner || !host) return;
        diagnostics.firstVideoFrameAt = now(); send('milestone', { name: 'first-video-frame' }); publish();
      });
      watchdog = setTimeout(() => degrade('media-timeout'), 12000);
    }
    publish();
    clearInterval(poll); poll = setInterval(() => send('probe'), 250);
    send('probe', { replay });
  }
  function receive(message) {
    if (disposed || message.token !== config.token) return;
    if (message.kind === 'state') { state = message.state; requestPending = false; publish(); }
    if (message.kind === 'preferences') {
      preferences = message.preferences;
      if (!preferences.enabled) remove(); else publish();
    }
    if (message.kind === 'replay') { remove(); state.ready = false; mount(true); }
    if (message.kind === 'dismiss') remove();
    if (message.kind === 'degraded') { degrade('host-incompatible'); return; }
    if (message.kind === 'login') {
      remove(); loginObserver?.disconnect();
      loginObserver = new MutationObserver(() => {
        if (config.host?.selectors && document.querySelector(config.host.selectors.sidebar) && document.querySelector(config.host.selectors.main)) {
          loginObserver.disconnect(); state.ready = false; mount();
        }
      });
      loginObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (message.kind === 'enter') {
      requestPending = false;
      if (!host || !state.ready || (message.reason === 'auto' && (!preferences.autoEnterOnReady || !introDone))) return;
      exiting = true;
      diagnostics.enteredAt = now(); publish();
      send('milestone', { name: 'entered' });
      clearInterval(poll); shadow.querySelector('.screen').classList.add('fading');
      leaving = setTimeout(remove, reduced.matches ? 0 : 250);
    }
  }
  const observer = new MutationObserver(() => {
    if (document.documentElement) { observer.disconnect(); if (config.show) mount(); }
  });
  // Disconnect the mounting observer after the document element exists; React
  // owns #root, whereas our host is its sibling outside that ownership boundary.
  if (document.documentElement) { if (config.show) mount(); }
  else {
    observer.observe(document, { childList: true });
  }
  reduced.addEventListener('change', () => { if (reduced.matches && host) fallback(); }, { signal: events.signal });
  return { receive, dispose() { disposed = true; observer.disconnect(); loginObserver?.disconnect(); events.abort(); remove(); } };
}

if (typeof window === 'undefined') {
  module.exports = { installStartupScreen };
} else if (process.isMainFrame) {
  const { ipcRenderer } = require('electron');
  let screen, config, serviceListener;
  const stateListener = (_event, value) => {
    if (value?.kind === 'bootstrap' && !config) {
      config = value.config;
      if (!config?.token || config.host?.schema !== 1) return;
      const service = config.host.service;
      serviceListener = (_event, message) => {
        if (![service.initialized, service.connection].includes(message?.type)) return;
        ipcRenderer.send('sandrone:startup-action', { token: config.token, action: 'host', hostId: message.hostId, type: message.type, state: message.state });
      };
      ipcRenderer.on(service.channel, serviceListener);
      screen = installStartupScreen(config, (action, detail = {}) => ipcRenderer.send('sandrone:startup-action', { ...detail, token: config.token, action }));
    } else screen?.receive(value);
  };
  ipcRenderer.on('sandrone:startup-state', stateListener);
  // The main process validates the exact allowed host surface before replying.
  // Missing replies do not block the renderer or create a covering element.
  ipcRenderer.send('sandrone:startup-bootstrap');
  window.addEventListener('pagehide', () => {
    screen?.dispose();
    ipcRenderer.removeListener('sandrone:startup-state', stateListener);
    if (serviceListener) ipcRenderer.removeListener(config.host.service.channel, serviceListener);
  }, { once: true });
}

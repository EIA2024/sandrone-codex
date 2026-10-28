// Executed in the app's main world; reads layout and theme state without
// sending messages, focusing the editor or modifying any user data.
async function inspectWorkspace(expected) {
  const active = selector => [...document.querySelectorAll(selector)].filter(node => !node.closest('[data-app-shell-active-page="false"]'));
  const visible = node => {
    if (!node?.isConnected) return false;
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.x < innerWidth && box.y < innerHeight && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const main = active('main:is(.main-surface,[data-app-shell-main-surface],[class*="_MainContentSurface_"])').find(visible);
  const sidebar = active('aside.app-shell-left-panel').find(visible);
  const loading = active('.startup-loader,[data-app-shell-loading="true"]').some(visible);
  const login = !main && active('input[type="email"],input[type="password"],a[href*="/auth/"],button[data-testid*="login"],button[data-testid*="sign-in"]').some(visible);
  const settings = main?.querySelector('[data-settings-panel-slug],[data-ds-part="settings-panel"],input[name="appearance-theme"]');
  const editor = main && [...main.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].find(node => visible(node) && !node.disabled && !node.readOnly && node.getAttribute('aria-disabled') !== 'true');
  const control = main && [...main.querySelectorAll('button,a[href],input,select')].find(node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
  const composer = main?.querySelector('[data-codex-composer-root],[data-ds-part="composer"],textarea,[contenteditable]');
  const workspace = Boolean(main && sidebar && !loading);
  const structure = workspace && main.getAttribute('aria-busy') !== 'true' && Boolean(settings ? control : composer ? editor : control);
  const runtime = window.__CODEX_DREAM_SKIN_STATE__;
  const native = window.__SANDRONE_NATIVE_UI__;
  const stylePresent = runtime?.styleMode === 'adopted' ? document.adoptedStyleSheets.includes(runtime.styleSheet)
    : runtime?.styleMode === 'style' && document.getElementById('codex-dream-skin-style') === runtime.styleNode;
  const styled = Boolean(expected && document.documentElement.getAttribute('data-dream-skin') === 'active' && runtime?.themeId === expected.themeId && runtime?.revision === expected.revision && stylePresent && native && document.adoptedStyleSheets.includes(native.sheet));
  let images = styled, imageError = false;
  // Theme backgrounds are CSS images, not HTMLImageElements. Cache decode
  // results by URL and only inspect the visible theme surfaces, not chat media.
  const cache = window.__SANDRONE_READINESS_IMAGES__ ??= new Map();
  if (styled) {
    const surfaces = [document.documentElement, document.body, main, sidebar, ...active('[data-ds-part="wallpaper"],#codex-dream-skin-wallpaper')].filter(Boolean);
    const urls = new Set();
    for (const surface of surfaces) for (const pseudo of [null, '::before', '::after']) {
      const background = getComputedStyle(surface, pseudo).backgroundImage;
      for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) urls.add(match[1]);
    }
    for (const url of urls) {
      if (!cache.has(url)) {
        const record = { ready: false, failed: false }, image = new Image(); cache.set(url, record);
        image.src = url; image.decode().then(() => { record.ready = true; }, () => { record.failed = true; });
      }
      const record = cache.get(url); images &&= record.ready; imageError ||= record.failed;
    }
  }
  const fonts = !document.fonts || document.fonts.status === 'loaded';
  // Markers here describe loaded controls, not successful remote network calls.
  // The coordinator additionally checks the real local app-server lifecycle.
  return { workspace, structure, theme: styled && images && fonts, imageError, login, loading, route: settings ? 'settings' : editor ? 'editor' : 'page' };
}

function updateHost(hosts, message) {
  if (typeof message.hostId !== 'string' || message.hostId.length > 256) return;
  const previous = hosts.get(message.hostId) || { initialized: false, connected: false };
  if (message.type === 'codex-app-server-initialized') previous.initialized = true;
  if (message.type === 'codex-app-server-connection-changed') {
    previous.connected = message.state === 'connected';
    previous.failed = message.state === 'error';
    if (!previous.connected) previous.initialized = false;
  }
  hosts.set(message.hostId, previous);
}

function startupState(probe, hosts, settled, elapsed) {
  const local = hosts.get('local');
  const connected = Boolean(local?.initialized && local?.connected);
  const steps = [true, connected, Boolean(probe.workspace), Boolean(probe.theme), Boolean(settled && probe.structure && connected && probe.theme)];
  const ready = steps.every(Boolean);
  const labels = ['正在启动页面', '正在连接工作区服务', '正在加载工作区', '正在加载桑多涅主题', '正在检查工作区交互'];
  const status = ready ? '工作区与桑多涅主题已就绪' : probe.login ? '需要登录 Codex' : probe.imageError ? '主题图片加载失败' : local?.failed ? '工作区服务连接失败' : labels[steps.findIndex(value => !value)];
  return { steps, ready, status, login: Boolean(probe.login), recovery: Boolean(probe.login || probe.imageError || local?.failed || elapsed > 30000) };
}

module.exports = { inspectWorkspace, updateHost, startupState };

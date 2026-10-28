const { hostContract, updateService } = require('./host-adapter.cjs');

// Executed in the app's main world; reads layout and theme state without
// sending messages, focusing the editor or modifying any user data.
async function inspectWorkspace(expected, contract) {
  const selectors = contract.selectors;
  const active = selector => [...document.querySelectorAll(selector)].filter(node => !node.closest(selectors.inactive));
  const visible = node => {
    if (!node?.isConnected) return false;
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.x < innerWidth && box.y < innerHeight && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const main = active(selectors.main).find(visible);
  const sidebar = active(selectors.sidebar).find(visible);
  const loading = active(selectors.loading).some(visible);
  const login = !main && active(selectors.login).some(visible);
  const settings = main?.querySelector(selectors.settings);
  const editor = main && [...main.querySelectorAll(selectors.editor)].find(node => visible(node) && !node.disabled && !node.readOnly && node.getAttribute('aria-disabled') !== 'true');
  const control = main && [...main.querySelectorAll(selectors.control)].find(node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
  const composer = main?.querySelector(selectors.composer);
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
    const surfaces = [document.documentElement, document.body, main, sidebar, ...active(selectors.wallpaper)].filter(Boolean);
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
  // Service lifecycle is reported independently by the coordinator.
  return { workspace, structure, theme: styled && images && fonts, imageError, login, loading, route: settings ? 'settings' : editor ? 'editor' : 'page' };
}

// Service messages are optional host evidence; they never prove that the UI is
// usable and their absence must not turn the theme into a startup dependency.
const updateHost = updateService;
function startupState(probe, hosts, settled, elapsed) {
  const local = hosts.get(hostContract.service.localHost);
  const connected = Boolean(local?.initialized && local?.connected);
  const serviceStatus = connected ? 'connected' : local?.failed ? 'error' : local ? 'disconnected' : 'unknown';
  const ready = Boolean(settled && probe.workspace && probe.structure && probe.theme);
  const steps = [true, connected, Boolean(probe.workspace), Boolean(probe.theme), ready];
  const degraded = Boolean(probe.compatibilityError || probe.imageError || (!ready && elapsed >= 30000));
  const status = degraded ? '部分主题效果不可用，已让出工作区'
    : ready ? connected ? '界面与主题已就绪' : '界面与主题已就绪 · 服务状态尚未确认'
    : probe.login ? '需要登录 Codex' : !probe.workspace ? '正在加载工作区'
    : !probe.theme ? '正在加载桑多涅主题' : '正在检查工作区交互';
  return { steps, ready, serviceStatus, status, degraded, login: Boolean(probe.login), recovery: degraded || Boolean(probe.login) };
}

module.exports = { inspectWorkspace, updateHost, startupState };

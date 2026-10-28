// The native integration's only Codex-specific contract. The serializable
// portion also travels to sandboxed preloads, which cannot require siblings.
const hostContract = {
  schema: 1,
  origin: { protocol: 'app:', hostname: '-', pathname: '/index.html' },
  excludedRoutes: ['/avatar-overlay', '/screen-overlay'],
  mediaPrefix: 'app://fs/@fs/',
  service: {
    channel: 'codex_desktop:message-for-view',
    initialized: 'codex-app-server-initialized',
    connection: 'codex-app-server-connection-changed',
    localHost: 'local',
  },
  selectors: {
    inactive: '[data-app-shell-active-page="false"]',
    main: 'main:is(.main-surface,[data-app-shell-main-surface],[class*="_MainContentSurface_"]),[data-ds-part="main"],[data-ds-part="home"]',
    sidebar: 'aside.app-shell-left-panel,[data-ds-part="sidebar"]',
    loading: '.startup-loader,[data-app-shell-loading="true"]',
    login: 'input[type="email"],input[type="password"],a[href*="/auth/"],button[data-testid*="login"],button[data-testid*="sign-in"]',
    settings: '[data-settings-panel-slug],[data-ds-part="settings-panel"],input[name="appearance-theme"]',
    editor: 'textarea,[contenteditable="true"],[role="textbox"]',
    control: 'button,a[href],input,select',
    composer: '[data-codex-composer-root],[data-ds-part="composer"],textarea,[contenteditable]',
    wallpaper: '[data-ds-part="wallpaper"],#codex-dream-skin-wallpaper',
    titlebar: '[class*="ApplicationMenuTopBar_"]',
  },
};

function isShellUrl(value) {
  try {
    const url = new URL(value), origin = hostContract.origin;
    const route = url.searchParams.get('initialRoute') || '';
    return url.protocol === origin.protocol && url.hostname === origin.hostname &&
      url.pathname === origin.pathname && !hostContract.excludedRoutes.some(prefix => route === prefix || route.startsWith(prefix + '/'));
  } catch { return false; }
}

function mediaUrl(file) {
  return hostContract.mediaPrefix + encodeURI(file.replaceAll('\\', '/'));
}

// Serialized into the main world; only recognizes the adapter's supported
// shell. Unknown markup still gets the independent management controls.
function inspectShell(contract) {
  const active = selector => [...document.querySelectorAll(selector)].find(node => !node.closest(contract.selectors.inactive));
  return Boolean(active(contract.selectors.main) || active(contract.selectors.sidebar));
}

function updateService(hosts, message) {
  const service = hostContract.service;
  if (![service.initialized, service.connection].includes(message.type) || typeof message.hostId !== 'string' || message.hostId.length > 256) return;
  const previous = hosts.get(message.hostId) || { initialized: false, connected: false };
  if (message.type === service.initialized) previous.initialized = true;
  if (message.type === service.connection) {
    previous.connected = message.state === 'connected';
    previous.failed = message.state === 'error';
    if (!previous.connected) previous.initialized = false;
  }
  hosts.set(message.hostId, previous);
}

module.exports = { hostContract, isShellUrl, mediaUrl, inspectShell, updateService };

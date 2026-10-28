const { isShellUrl } = require('./host-adapter.cjs');

const actions = new Set(['enable', 'disable', 'replay', 'opening', 'auto-enter', 'uninstall', 'cancel-uninstall', 'status']);
function readAction(details, mainFrame, prefix) {
  // Electron supplies the originating frame. Fail closed on older event forms
  // rather than accepting commands from embedded third-party pages.
  if (!details || details.frame !== mainFrame || typeof details.message !== 'string') return null;
  if (!details.message.startsWith(prefix)) return null;
  const action = details.message.slice(prefix.length);
  return actions.has(action) ? action : null;
}

module.exports = { isShellUrl, readAction };

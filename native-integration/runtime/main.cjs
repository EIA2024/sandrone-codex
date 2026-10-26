const fs = require('node:fs');
const path = require('node:path');

// This entry is optional. The bridge preserves the updater module's exports
// and exceptions; a theme failure must not prevent official app startup.
try {
  const root = path.resolve(__dirname, '..');
  const installation = JSON.parse(fs.readFileSync(path.join(root, 'installation.json'), 'utf8'));
  const packageDirectory = path.basename(path.dirname(path.dirname(process.resourcesPath)));
  if (process.type !== 'browser' || process.platform !== 'win32' || installation.schema !== 1 ||
      installation.targetPackage !== packageDirectory ||
      installation.addonName !== 'Local.Sandrone.CodexNativeTheme' ||
      typeof installation.addonPackageFullName !== 'string') {
    throw new Error('Unsupported Sandrone native theme host');
  }
  const key = Symbol.for('sandrone.native.integration');
  if (!globalThis[key]) {
    const { startIntegration } = require('./integration.cjs');
    globalThis[key] = startIntegration(require('electron'), root, installation);
  }
} catch (error) {
  console.error('Sandrone theme was not loaded:', error.message);
}

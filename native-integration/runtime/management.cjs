const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function createManagement(installationRoot, dataRoot, installation) {
  return action => new Promise((resolve, reject) => {
    if (!['Schedule', 'Cancel', 'Status'].includes(action)) {
      reject(new Error('Unsupported theme management action'));
      return;
    }
    try {
      const directory = path.join(dataRoot, 'management');
      fs.mkdirSync(directory, { recursive: true });
      const source = path.join(installationRoot, 'management', 'uninstall.ps1');
      const script = path.join(directory, 'uninstall.ps1');
      // The worker must remain available after the package's virtual files
      // disappear. Only this packaged script is copied, never renderer input.
      fs.copyFileSync(source, script);
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action,
        '-StateDirectory', dataRoot, '-ExpectedPackageFullName', installation.addonPackageFullName];
      execFile(powershell, args, { windowsHide: true, timeout: 30000, maxBuffer: 65536 }, (error, stdout, stderr) => {
        if (error && !stdout.trim()) { reject(new Error((stderr || error.message).trim())); return; }
        try {
          const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
          if (!result || !['idle', 'scheduled', 'removing', 'completed', 'cancelled', 'error'].includes(result.status)) throw new Error('Invalid uninstall status');
          // A worker failure is a state transition: the menu must unlock retry
          // and enable actions before presenting the helper's error message.
          resolve(result);
        } catch (parseError) { reject(parseError); }
      });
    } catch (error) { reject(error); }
  });
}

module.exports = { createManagement };

const fs = require('node:fs');
const path = require('node:path');

const defaults = Object.freeze({ schema: 1, enabled: true, openingOnLaunch: true });

function readPreferences(directory) {
  try {
    const file = path.join(directory, 'settings.json');
    if (fs.statSync(file).size > 4096) return { ...defaults };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schema !== 1) return { ...defaults };
    return {
      schema: 1,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
      openingOnLaunch: typeof value.openingOnLaunch === 'boolean' ? value.openingOnLaunch : defaults.openingOnLaunch,
    };
  } catch { return { ...defaults }; }
}

function writePreferences(directory, value) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'settings.json');
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({
    schema: 1, enabled: value.enabled === true, openingOnLaunch: value.openingOnLaunch === true,
  }, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

module.exports = { readPreferences, writePreferences };

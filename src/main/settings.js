const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { video: null, audio: null, volume: 1, bounds: null, clipMic: null };

let current = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (current) return current;
  try {
    current = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    // Primeira execução ou arquivo corrompido: o app abre com os valores padrão.
    current = { ...DEFAULTS };
  }
  return current;
}

function save(patch) {
  current = { ...load(), ...patch };
  // Grava em outro arquivo e renomeia: uma queda no meio não corrompe a configuração.
  const temp = `${settingsPath()}.tmp`;
  fs.mkdirSync(path.dirname(temp), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(current, null, 2));
  fs.renameSync(temp, settingsPath());
}

module.exports = { load, save };

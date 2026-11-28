'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJsonc } = require('./jsonc');

function configHome() {
  const home = os.homedir();
  if (process.platform === 'win32') return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function dataDir() {
  return process.env.T3_EXTENSION_HOST_HOME || path.join(configHome(), 't3-extension-host');
}

const DEFAULTS = {
  extensions: '*',
  exclude: [
    'anthropic.claude-code',
    'openai.chatgpt',
    'openai.codex-audio',
    'github.copilot',
    'github.copilot-chat',
    'saoudrizwan.claude-dev',
    'rooveterinaryinc.roo-cline',
    'continue.continue',
    'google.geminicodeassist',
    'sourcegraph.cody-ai',
    'kilocode.kilo-code',
  ],
  respectVSCodeDisabled: true,
  extensionsDir: path.join(os.homedir(), '.vscode', 'extensions'),
  vscodeSettings: path.join(configHome(), 'Code', 'User', 'settings.json'),
  vscodeStateDb: path.join(configHome(), 'Code', 'User', 'globalStorage', 'state.vscdb'),
  vscodeGlobalStorage: path.join(configHome(), 'Code', 'User', 'globalStorage'),
  vscodeInstallDir: process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code')
    : process.platform === 'darwin'
      ? '/Applications/Visual Studio Code.app/Contents'
      : '/usr/share/code',
  shareVSCodeStorage: true,
  activationTimeoutSeconds: 15,
  t3Home: process.env.T3CODE_HOME || path.join(os.homedir(), '.t3'),
  appName: 'T3 Code',
  windowProcessPattern: '^T3 Code',
  pollMs: 1500,
  agentPulseSeconds: 30,
  editorLingerSeconds: 300,
  ignoreOutsideWorkspace: true,
  ignoreProjects: [],
  reconnectDiscordSeconds: 30,
  logLevel: 'info',
};

function loadConfig() {
  const dir = dataDir();
  const file = path.join(dir, 'config.json');
  let user = {};
  try {
    user = parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Ignoring ${file}: ${error.message}`);
  }
  const config = { ...DEFAULTS, ...user, dataDir: dir, configFile: file };
  if (process.env.T3_EXTENSION_HOST_LOG_LEVEL) config.logLevel = process.env.T3_EXTENSION_HOST_LOG_LEVEL;
  config.logFile = path.join(dir, 'logs', 'host.log');
  config.stateDir = process.env.T3_EXTENSION_HOST_SANDBOX || dir;
  return config;
}

module.exports = { loadConfig, DEFAULTS };

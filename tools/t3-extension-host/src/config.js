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

const ASSETS_URL = 'https://raw.githubusercontent.com/5djr/t3code/discord-assets';

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
  discordClientId: null,
  discordSmallImage: {
    idle: `${ASSETS_URL}/t3-circle-512.png`,
    working: `${ASSETS_URL}/t3-circle-512.png`,
    waiting: `${ASSETS_URL}/t3-circle-512.png`,
    editing: `${ASSETS_URL}/t3-circle-512.png`,
  },
  discordSmallText: {
    idle: 'T3 Code',
    working: 'T3 Code · {model}',
    waiting: 'T3 Code · {model}',
    editing: 'T3 Code · {model}',
  },
  discordLargeImages: {
    idle: `${ASSETS_URL}/t3-idle.png`,
    working: `${ASSETS_URL}/t3-working.png`,
    waiting: `${ASSETS_URL}/t3-waiting.png`,
    editing: 'language',
  },
  discordLanguageImages: {},
  discordPresenceImages: `${ASSETS_URL}/presence`,
  discordShowButtons: false,
  discordSwapImages: false,
  discordStatus: {
    idle: { details: 'Idling in T3 Code', state: '{project}', largeText: 'Idling' },
    working: { details: 'Agent working in {project}', state: '{thread}', largeText: '{agent} is working' },
    waiting: { details: 'Waiting for input in {project}', state: '{thread}', largeText: '{agent} needs an answer' },
    editing: { details: 'Agent editing {file}', state: '{thread}', largeText: 'Editing a {language} file' },
  },
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
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  for (const key of ['discordLargeImages', 'discordSmallImage', 'discordSmallText']) {
    if (isObject(user[key])) config[key] = { ...DEFAULTS[key], ...user[key] };
  }
  if (!isObject(config.discordLanguageImages)) config.discordLanguageImages = {};
  if (isObject(user.discordStatus)) {
    config.discordStatus = Object.fromEntries(
      Object.entries(DEFAULTS.discordStatus).map(([mode, texts]) => {
        const custom = user.discordStatus[mode];
        return [mode, custom === null ? null : isObject(custom) ? { ...texts, ...custom } : texts];
      }),
    );
  }
  if (process.env.T3_EXTENSION_HOST_LOG_LEVEL) config.logLevel = process.env.T3_EXTENSION_HOST_LOG_LEVEL;
  config.logFile = path.join(dir, 'logs', 'host.log');
  config.stateDir = process.env.T3_EXTENSION_HOST_SANDBOX || dir;
  return config;
}

module.exports = { loadConfig, DEFAULTS };

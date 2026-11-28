'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readT3Runtime(t3Home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(t3Home, 'userdata', 'server-runtime.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isT3Running(t3Home) {
  const runtime = readT3Runtime(t3Home);
  return Boolean(runtime && isProcessAlive(runtime.pid));
}

function discordIpcPaths() {
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir();
  return Array.from({ length: 10 }, (_, i) => path.join(base, `discord-ipc-${i}`));
}

function isDiscordAvailable() {
  if (process.platform === 'win32') {
    try {
      return fs.readdirSync('\\\\.\\pipe\\').some((name) => /^discord-ipc-\d$/.test(name));
    } catch {
      return false;
    }
  }
  return discordIpcPaths().some((p) => fs.existsSync(p));
}

module.exports = { readT3Runtime, isProcessAlive, isT3Running, isDiscordAvailable };

'use strict';

const { execFileSync } = require('node:child_process');
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

let processScan = { at: 0, running: false };

function t3ProcessRunning() {
  if (process.platform !== 'win32') return false;
  if (Date.now() - processScan.at < 15_000) return processScan.running;
  let running = false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq T3 Code*', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    running = /"T3 Code/i.test(out);
  } catch {}
  processScan = { at: Date.now(), running };
  return running;
}

function isT3Running(t3Home) {
  const runtime = readT3Runtime(t3Home);
  if (runtime && isProcessAlive(runtime.pid)) return true;
  return t3ProcessRunning();
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

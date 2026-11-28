'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;

function format(part) {
  if (part instanceof Error) return part.stack || part.message;
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function createLogger({ file, level = 'info', console: toConsole = true, scope = 'host' }) {
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {}
  }
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, name, parts) {
    if (LEVELS[lvl] < threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${name}] ${parts.map(format).join(' ')}\n`;
    if (file) {
      try {
        fs.appendFileSync(file, line);
      } catch {}
    }
    if (toConsole) {
      try {
        (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
      } catch {}
    }
  }

  function scoped(name) {
    return {
      debug: (...parts) => write('debug', name, parts),
      info: (...parts) => write('info', name, parts),
      warn: (...parts) => write('warn', name, parts),
      error: (...parts) => write('error', name, parts),
      child: (childName) => scoped(childName),
      isDebug: threshold <= LEVELS.debug,
    };
  }

  return scoped(scope);
}

module.exports = { createLogger };

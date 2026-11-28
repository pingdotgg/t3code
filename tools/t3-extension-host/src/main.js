#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { fork } = require('node:child_process');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { isDiscordAvailable, isProcessAlive, isT3Running, readT3Runtime } = require('./runtime');

const CHECK_INTERVAL_MS = 3000;
const config = loadConfig();

function runCheck() {
  const { discoverAll, readDisabled, selectExtensions } = require('./host/extensions');
  const { T3State } = require('./host/t3-state');
  const yes = (ok) => (ok ? 'ok' : 'MISSING');
  const runtime = readT3Runtime(config.t3Home);
  const running = Boolean(runtime && isProcessAlive(runtime.pid));
  const dbPath = path.join(config.t3Home, 'userdata', 'statev2.sqlite');
  console.log(`T3 Code home:        ${config.t3Home} (${yes(fs.existsSync(config.t3Home))})`);
  console.log(`T3 Code running:     ${running ? `yes (v${runtime.serverVersion}, pid ${runtime.pid})` : 'no'}`);
  try {
    const state = new T3State({ t3Home: config.t3Home, logger: { debug() {} } });
    state.open();
    const { focus, runningThreadIds } = state.poll();
    state.close();
    console.log(`State database:      ok (${runningThreadIds.size} running agent thread(s))`);
    if (focus) console.log(`Current thread:      "${focus.title}" in ${focus.projectTitle} (${focus.root})`);
  } catch (error) {
    console.log(`State database:      ERROR ${dbPath}: ${error.message}`);
  }
  const { registry, vscodeApp } = discoverAll(config);
  const disabled = config.respectVSCodeDisabled ? readDisabled(config.vscodeStateDb) : new Set();
  const enabled = selectExtensions(config, registry, disabled);
  const installed = [...registry].filter(([, found]) => !found.builtin);
  console.log(`VS Code install:     ${vscodeApp ?? 'not found (built-in extensions unavailable)'}`);
  console.log(`VS Code extensions:  ${config.extensionsDir} (${installed.length} installed, ${enabled.size} enabled for T3 Code)`);
  for (const [key, found] of installed.sort(([a], [b]) => a.localeCompare(b))) {
    const status = enabled.has(key) ? 'enabled' : disabled.has(key) ? 'disabled in VS Code' : 'excluded';
    console.log(`  ${`${found.id} ${found.version}`.padEnd(48)} ${status}`);
  }
  console.log(`VS Code settings:    ${config.vscodeSettings} (${fs.existsSync(config.vscodeSettings) ? 'found' : 'not found, using defaults'})`);
  console.log(`Discord:             ${isDiscordAvailable() ? 'running' : 'not detected'}`);
  console.log(`Host config:         ${config.configFile} (${fs.existsSync(config.configFile) ? 'found' : 'defaults'})`);
  console.log(`Log file:            ${config.logFile}`);
}

function acquireLock(onAcquired, onBusy) {
  const lockPath = process.platform === 'win32' ? '\\\\.\\pipe\\t3-extension-host' : path.join(config.dataDir, 'host.sock');
  const server = net.createServer((socket) => socket.end());
  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') throw error;
    if (process.platform === 'win32') return onBusy();
    const probe = net.connect(lockPath);
    probe.on('connect', () => {
      probe.end();
      onBusy();
    });
    probe.on('error', () => {
      fs.rmSync(lockPath, { force: true });
      server.listen(lockPath, onAcquired);
    });
  });
  fs.mkdirSync(config.dataDir, { recursive: true });
  server.listen(lockPath, onAcquired);
  server.unref();
}

function supervise() {
  const logger = createLogger({ file: config.logFile, level: config.logLevel, console: Boolean(process.stdout.isTTY), scope: 'supervisor' });
  let child = null;
  let restartAt = 0;
  let failures = 0;

  const stopChild = (reason) => {
    const current = child;
    if (!current) return Promise.resolve();
    logger.info(`${reason}; stopping extensions`);
    current.expectedExit = true;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => current.kill(), 5000);
      current.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      if (current.connected) current.send({ type: 'shutdown' });
      else current.kill();
    });
  };

  const startChild = () => {
    logger.info('T3 Code is running; starting extensions');
    const startedAt = Date.now();
    const current = fork(path.join(__dirname, 'host', 'index.js'), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--no-warnings'],
      windowsHide: true,
    });
    const forward = (chunk) => process.stdout.isTTY && process.stdout.write(chunk);
    current.stdout.on('data', forward);
    current.stderr.on('data', forward);
    current.on('exit', (code, signal) => {
      if (child === current) child = null;
      if (current.expectedExit) return;
      failures = Date.now() - startedAt > 60_000 ? 1 : failures + 1;
      const delay = Math.min(60_000, 2000 * 2 ** (failures - 1));
      restartAt = Date.now() + delay;
      logger.warn(`Extension host exited unexpectedly (${signal ?? code}); retrying in ${delay / 1000}s`);
    });
    child = current;
  };

  const check = () => {
    const running = isT3Running(config.t3Home);
    if (running && !child && Date.now() >= restartAt) startChild();
    else if (!running && child) stopChild('T3 Code closed');
  };

  logger.info(`T3 Extension Host started; waiting for T3 Code (${config.t3Home})`);
  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);

  const exit = async (signal) => {
    clearInterval(timer);
    await stopChild(`Received ${signal}`);
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => exit(signal));
}

function nodeTooOld() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major < 22 || (major === 22 && minor < 15);
}

if (nodeTooOld()) {
  const message = `Node.js ${process.versions.node} is too old; T3 Extension Host needs 22.15 or newer`;
  createLogger({ file: config.logFile, level: 'error', console: true, scope: 'supervisor' }).error(message);
  process.exit(1);
} else if (process.argv.includes('--check')) {
  runCheck();
} else {
  acquireLock(supervise, () => {
    console.log('T3 Extension Host is already running.');
    process.exit(0);
  });
}

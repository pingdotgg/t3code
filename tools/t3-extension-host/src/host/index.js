'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadConfig } = require('../config');
const { createLogger } = require('../logger');
const { isDiscordAvailable, readT3Runtime } = require('../runtime');
const { agentName, installDiscordOverrides, languageName, modelName } = require('./discord');
const { ExtensionHost, discoverAll, installVscodeModule, readDisabled, selectExtensions } = require('./extensions');
const { FocusWatcher } = require('./focus-watcher');
const { createGitExtension } = require('./git');
const { SettingsStore } = require('./settings');
const { missingApis, setMissingReporter } = require('./stub');
const { T3State, countLines } = require('./t3-state');
const { setErrorReporter } = require('./types');
const { Workbench, isInside } = require('./workbench');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SCAN_TARGET = process.env.T3_EXTENSION_HOST_SCAN;

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const config = loadConfig();
const logger = createLogger({ file: SCAN_TARGET ? null : config.logFile, level: config.logLevel, console: !SCAN_TARGET, scope: 'host' });
const runtimeErrors = [];
const recordError = (error) => runtimeErrors.push(String(error?.message ?? error).split('\n')[0]);
setErrorReporter((error) => {
  recordError(error);
  logger.child('extension').error(error);
});
process.on('uncaughtException', (error) => {
  recordError(error);
  logger.error('Uncaught exception:', error);
});
process.on('unhandledRejection', (error) => {
  recordError(error);
  logger.warn('Unhandled rejection:', error);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function t3AppRoot() {
  const candidate = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 't3code') : null;
  return candidate && fs.existsSync(candidate) ? candidate : undefined;
}

function describeHeartbeat({ entity, category, ai_line_changes: aiLines, alternate_project: project, is_write: isWrite }) {
  const parts = [entity, `category=${category ?? 'coding'}`];
  if (aiLines) parts.push(`ai-lines=${aiLines}`);
  if (project) parts.push(`project=${project}`);
  if (isWrite) parts.push('write');
  return parts.join(' ');
}

function traceHeartbeats() {
  const log = logger.child('wakatime');
  const original = childProcess.execFile;
  childProcess.execFile = function execFile(file, args, ...rest) {
    const child = original.call(this, file, args, ...rest);
    if (typeof file !== 'string' || !/wakatime-cli/i.test(path.basename(file)) || !Array.isArray(args) || !args.includes('--entity')) return child;
    const value = (flag) => {
      const index = args.indexOf(flag);
      return index >= 0 ? String(args[index + 1]).replace(/^"|"$/g, '') : undefined;
    };
    log.info(`Heartbeat ${describeHeartbeat({
      entity: value('--entity'),
      category: value('--category'),
      ai_line_changes: value('--ai-line-changes'),
      alternate_project: value('--alternate-project'),
      is_write: args.includes('--write'),
    })}`);
    if (args.includes('--extra-heartbeats') && child?.stdin) {
      const write = child.stdin.write;
      child.stdin.write = function writeExtra(chunk, ...writeArgs) {
        child.stdin.write = write;
        try {
          for (const heartbeat of JSON.parse(String(chunk))) log.info(`Heartbeat ${describeHeartbeat(heartbeat)}`);
        } catch {}
        return write.call(this, chunk, ...writeArgs);
      };
    }
    return child;
  };
}

class Bridge {
  constructor({ workbench, state }) {
    this.workbench = workbench;
    this.state = state;
    this.log = logger.child('bridge');
    this.ignored = new Set(config.ignoreProjects.map((name) => String(name).toLowerCase()));
    this.lingerMs = config.editorLingerSeconds * 1000;
    this.pulseMs = config.agentPulseSeconds * 1000;
    this.threadId = null;
    this.thread = null;
    this.agentRunning = false;
    this.agentWaiting = false;
    this.agent = null;
    this.onTick = null;
    this.lastEditAt = 0;
    this.lastEditThread = null;
    this.lastPulseAt = 0;
    this.lastReconnectAt = Date.now();
    this.lastStatus = '';
  }

  isIgnored(thread) {
    return !thread?.root || this.ignored.has(thread.projectTitle.toLowerCase());
  }

  focus(thread) {
    if ((thread?.threadId ?? null) === this.threadId) {
      if (thread) this.thread = thread;
      return;
    }
    this.threadId = thread?.threadId ?? null;
    this.thread = thread ?? null;
    const folder = thread && !this.isIgnored(thread) ? { root: thread.root, name: thread.projectTitle } : null;
    if (!this.workbench.setWorkspace(folder)) return;
    this.workbench.clearEditor();
    this.log.info(folder ? `Workspace is now ${folder.name} (${folder.root})` : 'No workspace');
  }

  applyEdit(edit, now) {
    const { thread } = edit;
    if (this.isIgnored(thread)) return;
    for (const file of edit.files) {
      if (config.ignoreOutsideWorkspace && !isInside(file.path, thread.root) && !isInside(file.path, thread.projectRoot)) {
        this.log.debug(`Skipping ${file.path}: outside ${thread.root}`);
        continue;
      }
      let text;
      try {
        if (fs.statSync(file.path).size > MAX_FILE_BYTES) continue;
        text = fs.readFileSync(file.path, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      this.focus(thread);
      const lineCount = Math.max(1, countLines(text));
      const previousLineCount = file.created ? 0 : typeof file.delta === 'number' ? Math.max(0, lineCount - file.delta) : undefined;
      let line = file.line;
      if (line === undefined && file.snippet) {
        const index = text.indexOf(file.snippet);
        if (index >= 0) line = Math.max(0, countLines(text.slice(0, index)) - 1);
      }
      this.workbench.applyAgentEdit(file.path, text, { previousLineCount, line });
      this.lastEditAt = now;
      this.lastEditThread = thread;
      this.lastPulseAt = now;
      this.log.info(`Agent edited ${path.relative(thread.root, file.path)} in ${thread.projectTitle}`);
    }
  }

  tick() {
    const now = Date.now();
    const snapshot = this.state.poll();
    for (const edit of snapshot.edits) this.applyEdit(edit, now);

    const editIsRecent = this.lastEditThread && now - this.lastEditAt < this.lingerMs;
    this.focus(editIsRecent ? this.lastEditThread : snapshot.focus);

    const agentRunning = Boolean(this.threadId && snapshot.runningThreadIds.has(this.threadId));
    this.agentRunning = agentRunning;
    this.agentWaiting = agentRunning && Boolean(snapshot.waitingThreadIds?.has(this.threadId));
    this.agent = agentRunning ? (snapshot.agents?.get(this.threadId) ?? null) : null;
    this.workbench.setAgentActive(agentRunning);
    if (agentRunning) {
      if (now - this.lastPulseAt >= this.pulseMs) {
        this.workbench.pulse();
        this.lastPulseAt = now;
      }
    } else if (this.workbench.activeEditor && now - this.lastEditAt >= this.lingerMs) {
      this.workbench.clearEditor();
    }

    this.reconnectDiscord(now);
    this.logStatus();
    try {
      this.onTick?.();
    } catch (error) {
      this.log.debug(`Discord status refresh failed: ${error.message}`);
    }
  }

  presenceContext() {
    const doc = this.workbench.activeEditor?.document;
    const shared = Boolean(this.workbench.workspaceRoot);
    return {
      mode: !this.agentRunning ? 'idle' : this.agentWaiting ? 'waiting' : doc ? 'editing' : 'working',
      project: this.workbench.workspaceName ?? 'T3 Code',
      thread: shared ? (this.thread?.title ?? '') : '',
      file: doc ? path.basename(doc.fileName) : '',
      language: languageName(doc?.languageId),
      languageId: doc?.languageId ?? '',
      extension: doc ? path.extname(doc.fileName).toLowerCase() : '',
      model: modelName(this.agent?.model),
      agent: agentName(this.agent?.provider) || 'Agent',
    };
  }

  reconnectDiscord(now) {
    if (!config.reconnectDiscordSeconds || now - this.lastReconnectAt < config.reconnectDiscordSeconds * 1000) return;
    const item = [...this.workbench.statusItems].find((i) => i.visible && i.command === 'discord.reconnect' && /reconnect/i.test(i.text));
    if (!item || !isDiscordAvailable()) return;
    this.lastReconnectAt = now;
    this.log.info('Discord is available; reconnecting Discord Presence');
    this.workbench.executeCommand('discord.reconnect').catch((error) => this.log.warn('Discord reconnect failed:', error));
  }

  logStatus() {
    const status = [...this.workbench.statusItems]
      .filter((item) => item.visible && item.text)
      .map((item) => item.text.replace(/\$\([\w-]+\)\s*/g, '').trim())
      .filter(Boolean)
      .join(' | ');
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.log.debug(`Status bar: ${status || '(empty)'}`);
  }
}

function withDependencies(registry, id) {
  const result = new Set();
  const visit = (key) => {
    if (result.has(key)) return;
    result.add(key);
    for (const dep of registry.get(key)?.pkg.extensionDependencies ?? []) visit(dep.toLowerCase());
  };
  visit(id.toLowerCase());
  return result;
}

async function scan(target, { workbench, settings, registry }) {
  const key = target.toLowerCase();
  const host = new ExtensionHost({ workbench, settings, logger, registry, enabled: withDependencies(registry, key) });
  const entry = host.entries.get(key);
  const started = Date.now();
  const outcome = await Promise.race([host.activate(target, 'scan').then(() => 'done'), sleep(config.activationTimeoutSeconds * 1000).then(() => 'timeout')]);
  const ms = Date.now() - started;
  await sleep(2000);
  const error = entry?.state.error;
  process.send?.({
    type: 'scan-result',
    id: entry?.id ?? target,
    status: !entry ? 'not installed' : outcome === 'timeout' ? 'still starting' : error ? 'failed' : 'activated',
    error: error ? String(error.message ?? error).split('\n')[0] : undefined,
    stack: error?.stack?.split('\n').slice(0, 8).join('\n'),
    ms,
    missing: missingApis(),
    runtimeErrors: [...new Set(runtimeErrors)],
  });
  await Promise.race([host.deactivateAll(), sleep(3000)]);
  process.exit(0);
}

function vscodeApiVersion(registry, vscodeApp) {
  const versions = ['1.100.0'];
  try {
    versions.push(JSON.parse(fs.readFileSync(path.join(vscodeApp, 'package.json'), 'utf8')).version);
  } catch {}
  for (const found of registry.values()) {
    const required = /(\d+)\.(\d+)\.(\d+)/.exec(found.pkg.engines?.vscode ?? '');
    if (required) versions.push(required.slice(1).join('.'));
  }
  const parse = (v) => v.split('.').map(Number);
  return versions.sort((a, b) => {
    const [pa, pb] = [parse(a), parse(b)];
    return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
  })[0];
}

async function main() {
  const runtime = readT3Runtime(config.t3Home);
  const { registry, vscodeApp } = discoverAll(config);
  const settings = new SettingsStore({
    vscodeSettingsPath: config.vscodeSettings,
    overridesPath: path.join(config.stateDir, 'settings.json'),
    logger: logger.child('settings'),
  });
  const workbench = new Workbench({
    appName: config.appName,
    version: vscodeApiVersion(registry, vscodeApp),
    appRoot: t3AppRoot(),
    dataDir: config.stateDir,
    sharedGlobalStorage: config.shareVSCodeStorage && fs.existsSync(config.vscodeGlobalStorage) ? config.vscodeGlobalStorage : undefined,
    settings,
    logger,
    git: createGitExtension(),
  });
  installVscodeModule(workbench.api);

  const owners = [...registry.values()].map((found) => ({ id: found.id, paths: [found.dir, pathToFileURL(found.dir).href] }));
  setMissingReporter((name, stack) => {
    const owner = owners.find(({ paths }) => paths.some((p) => stack.includes(p)));
    logger.child('compat').debug(`${owner?.id ?? 'An extension'} called vscode.${name}, which T3 Code can't provide; ignored`);
  });

  if (SCAN_TARGET) return scan(SCAN_TARGET, { workbench, settings, registry });

  traceHeartbeats();

  const disabled = config.respectVSCodeDisabled ? readDisabled(config.vscodeStateDb) : new Set();
  const enabled = selectExtensions(config, registry, disabled);
  const host = new ExtensionHost({
    workbench,
    settings,
    logger: logger.child('extensions'),
    registry,
    enabled,
    activationTimeoutMs: config.activationTimeoutSeconds * 1000,
  });
  const installed = [...registry.values()].filter((found) => !found.builtin).length;
  logger.info(`Found ${installed} installed extension(s); ${enabled.size} enabled for T3 Code, ${disabled.size} disabled in VS Code`);

  const state = new T3State({ t3Home: config.t3Home, logger: logger.child('t3') });
  const bridge = new Bridge({ workbench, state });
  bridge.onTick = await installDiscordOverrides({
    clientId: config.discordClientId,
    smallImage: config.discordSmallImage,
    smallText: config.discordSmallText,
    largeImages: config.discordLargeImages,
    languageImages: config.discordLanguageImages,
    swapImages: config.discordSwapImages,
    presenceImagesUrl: config.discordPresenceImages,
    showButtons: config.discordShowButtons,
    status: config.discordStatus,
    getContext: () => bridge.presenceContext(),
    cacheDir: config.stateDir,
    logger: logger.child('discord'),
  });
  let lastPollError = null;
  const poll = () => {
    try {
      bridge.tick();
      if (lastPollError) logger.info('Reading T3 Code activity again');
      lastPollError = null;
    } catch (error) {
      if (error.message !== lastPollError) logger.warn(`Can't read T3 Code activity (${error.message}); retrying quietly`);
      lastPollError = error.message;
    }
  };
  poll();
  await host.waitBriefly(host.startup());

  const watcher = new FocusWatcher({
    pattern: config.windowProcessPattern,
    logger: logger.child('focus'),
    onChange: (focused) => {
      logger.child('focus').debug(focused ? 'T3 Code focused' : 'T3 Code not focused');
      workbench.setWindowFocused(focused);
    },
    helperDir: path.join(config.stateDir, 'bin'),
  });
  watcher.start().catch((error) => logger.warn('Focus watcher failed:', error));

  let ticks = 0;
  const timer = setInterval(() => {
    poll();
    if (++ticks % 10 === 0) workbench.refreshSettings();
  }, config.pollMs);

  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Stopping extensions (${reason})`);
    clearInterval(timer);
    watcher.stop();
    await Promise.race([host.deactivateAll(), sleep(5000)]);
    workbench.disposeTerminals();
    state.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('message', (message) => message?.type === 'shutdown' && shutdown('T3 Code closed'));
  process.on('disconnect', () => shutdown('supervisor exited'));
  process.on('SIGINT', () => shutdown('interrupted'));
  process.on('SIGTERM', () => shutdown('terminated'));

  logger.info(`Extension host ready for T3 Code ${runtime?.serverVersion ?? ''}; ${host.active.length} extension(s) active, the rest start on their activation events`);
}

main().catch((error) => {
  logger.error('Extension host failed to start:', error);
  process.exit(1);
});


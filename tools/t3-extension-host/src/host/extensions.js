'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { Uri, registerLanguages } = require('./types');

const STARTUP_EVENTS = new Set(['*', 'onStartupFinished']);
const API_KEY = Symbol.for('t3.vscode');
const SHIM_URL = 't3-host:vscode';
const WORKSPACE_SCAN_PREFIX = 'workspaceContains:';
const WORKSPACE_SCAN_MS = 3000;
const IGNORED_DIRS = /(^|[\\/])(node_modules|bower_components|\.git|\.svn|\.hg)$/;

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function readDisabled(stateDb) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(stateDb, { readOnly: true });
    try {
      const row = db.prepare("select value from ItemTable where key = 'extensionsIdentifiers/disabled'").get();
      return new Set(JSON.parse(row?.value ?? '[]').map((entry) => String(entry.id).toLowerCase()));
    } finally {
      db.close();
    }
  } catch {
    return new Set();
  }
}

function discoverExtensions(extensionsDir) {
  const registry = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return registry;
  }
  let obsolete = {};
  try {
    obsolete = JSON.parse(fs.readFileSync(path.join(extensionsDir, '.obsolete'), 'utf8'));
  } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory() || obsolete[entry.name]) continue;
    const dir = path.join(extensionsDir, entry.name);
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.publisher || !pkg.name) continue;
    const id = `${pkg.publisher}.${pkg.name}`;
    const key = id.toLowerCase();
    const existing = registry.get(key);
    if (!existing || compareVersions(pkg.version, existing.version) > 0) registry.set(key, { id, version: pkg.version, dir, pkg });
  }
  return registry;
}

function findVSCodeApp(installDir) {
  if (!installDir) return null;
  const candidates = [path.join(installDir, 'resources', 'app')];
  try {
    for (const entry of fs.readdirSync(installDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(installDir, entry.name, 'resources', 'app'));
    }
  } catch {}
  const apps = candidates.filter((dir) => fs.existsSync(path.join(dir, 'package.json')));
  return apps.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

function discoverAll(config) {
  const registry = new Map();
  const vscodeApp = findVSCodeApp(config.vscodeInstallDir);
  if (vscodeApp) {
    for (const [key, found] of discoverExtensions(path.join(vscodeApp, 'extensions'))) registry.set(key, { ...found, builtin: true });
  }
  for (const [key, found] of discoverExtensions(config.extensionsDir)) registry.set(key, found);
  return { registry, vscodeApp };
}

function selectExtensions(config, registry, disabled = new Set()) {
  const lower = (id) => String(id).toLowerCase();
  const all = config.extensions === '*' || (Array.isArray(config.extensions) && config.extensions.includes('*'));
  const exclude = new Set((config.exclude ?? []).map(lower));
  const wanted = all
    ? [...registry].filter(([id, found]) => !found.builtin && !exclude.has(id)).map(([id]) => id)
    : [].concat(config.extensions).map(lower);
  return new Set(wanted.filter((id) => registry.has(id) && !disabled.has(id)));
}

function resolveMain(dir, main) {
  if (!main) return null;
  const base = path.resolve(dir, main);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function isEsm(mainPath, pkg) {
  return mainPath.endsWith('.mjs') || (pkg.type === 'module' && !mainPath.endsWith('.cjs'));
}

function activationEvents(pkg) {
  const events = new Set(pkg.activationEvents ?? []);
  const contributes = pkg.contributes ?? {};
  for (const command of contributes.commands ?? []) if (command?.command) events.add(`onCommand:${command.command}`);
  for (const language of contributes.languages ?? []) if (language?.id) events.add(`onLanguage:${language.id}`);
  return [...events];
}

function describeActivation(events) {
  if (events.some((event) => STARTUP_EVENTS.has(event))) return 'at startup';
  const parts = [];
  const languages = events.filter((event) => event === 'onLanguage' || event.startsWith('onLanguage:')).map((event) => event.slice(11) || 'any');
  if (languages.length) parts.push(`on ${languages.slice(0, 3).join('/')}${languages.length > 3 ? '/…' : ''} files`);
  if (events.some((event) => event.startsWith(WORKSPACE_SCAN_PREFIX))) parts.push('in matching projects');
  if (events.some((event) => event.startsWith('onCommand:'))) parts.push('when its commands run');
  return parts.join(', ') || 'never (editor UI only)';
}

function importedNames(fromUrl) {
  const names = new Set();
  try {
    const source = fs.readFileSync(fileURLToPath(fromUrl), 'utf8');
    const pattern = /(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']vscode["']/g;
    let match;
    while ((match = pattern.exec(source))) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  } catch {}
  return names;
}

function shimSource(fromUrl) {
  const api = globalThis[API_KEY];
  const names = new Set([...Object.keys(api), ...importedNames(fromUrl)]);
  names.delete('default');
  const lines = ['const api = globalThis[Symbol.for("t3.vscode")];', 'export default api;'];
  [...names].forEach((name, i) => lines.push(`const v${i} = api[${JSON.stringify(name)}];`, `export { v${i} as ${name} };`));
  return lines.join('\n');
}

function installVscodeModule(api) {
  globalThis[API_KEY] = api;
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    return request === 'vscode' ? api : originalLoad.call(this, request, ...rest);
  };
  if (typeof Module.registerHooks !== 'function') return;
  Module.registerHooks({
    resolve(specifier, context, next) {
      if (specifier !== 'vscode') return next(specifier, context);
      return { url: `${SHIM_URL}?from=${encodeURIComponent(context.parentURL ?? '')}`, format: 'module', shortCircuit: true };
    },
    load(url, context, next) {
      if (!url.startsWith(SHIM_URL)) return next(url, context);
      const from = new URL(url).searchParams.get('from') ?? '';
      return { format: 'module', source: shimSource(from), shortCircuit: true };
    },
  });
}

class ExtensionEntry {
  constructor(found, host) {
    this.id = found.id;
    this.version = found.version;
    this.extensionPath = found.dir;
    this.extensionUri = Uri.file(found.dir);
    this.extensionKind = 2;
    this.packageJSON = found.pkg;
    this.isActive = false;
    this.exports = undefined;
    Object.defineProperties(this, {
      host: { value: host },
      events: { value: activationEvents(found.pkg) },
      mainPath: { value: resolveMain(found.dir, found.pkg.main) },
      state: { value: { activation: null, module: null, context: null, error: null, activatedIn: null } },
    });
  }

  activate() {
    return this.host.activate(this.id, 'requested by another extension');
  }
}

class ExtensionHost {
  constructor({ workbench, settings, logger, registry, enabled, activationTimeoutMs = 15000 }) {
    this.workbench = workbench;
    this.logger = logger;
    this.enabled = enabled;
    this.activationTimeoutMs = activationTimeoutMs;
    this.entries = new Map();
    this.workspaceScans = new Map();
    for (const [key, found] of registry) {
      registerLanguages(found.pkg);
      settings.addDefaults(found.pkg);
      if (workbench.extensions.has(key)) continue;
      const entry = new ExtensionEntry(found, this);
      this.entries.set(key, entry);
      workbench.registerExtension(entry);
    }
    workbench.onUnknownCommand = (id) => this.waitBriefly(this.trigger((event) => event === `onCommand:${id}`));
    workbench.emit.openDocument.event((doc) => {
      this.trigger((event) => event === 'onLanguage' || event === `onLanguage:${doc.languageId}`);
    });
    workbench.emit.folders.event(({ added }) => {
      if (added.length) this.onWorkspace(added[0].uri.fsPath);
    });
  }

  get active() {
    return [...this.entries.values()].filter((entry) => entry.isActive);
  }

  waitBriefly(promise) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, this.activationTimeoutMs).unref())]);
  }

  isEnabled(entry) {
    return this.enabled.has(entry.id.toLowerCase());
  }

  activate(id, reason, chain = new Set()) {
    const entry = this.entries.get(String(id).toLowerCase());
    if (!entry || !this.isEnabled(entry)) return Promise.resolve(undefined);
    entry.state.activation ??= this.load(entry, reason, chain);
    return entry.state.activation;
  }

  async load(entry, reason, chain) {
    const key = entry.id.toLowerCase();
    chain.add(key);
    for (const dependency of entry.packageJSON.extensionDependencies ?? []) {
      if (/^vscode\./i.test(dependency)) continue;
      const dep = this.entries.get(dependency.toLowerCase());
      if (!dep || !this.isEnabled(dep)) {
        this.logger.warn(`${entry.id} depends on ${dependency}, which is ${dep ? 'excluded' : 'not installed'}; activating anyway`);
        continue;
      }
      if (chain.has(dependency.toLowerCase())) {
        this.logger.warn(`${entry.id} and ${dependency} depend on each other; activating ${entry.id} without waiting`);
        continue;
      }
      await this.activate(dependency, `dependency of ${entry.id}`, new Set(chain));
    }
    if (!entry.mainPath) {
      entry.isActive = true;
      return undefined;
    }
    const started = Date.now();
    try {
      entry.state.context = this.workbench.createContext(entry);
      if (isEsm(entry.mainPath, entry.packageJSON)) {
        if (typeof Module.registerHooks !== 'function') throw new Error('ES module extensions need Node 22.15 or newer');
        entry.state.module = await import(pathToFileURL(entry.mainPath).href);
      } else {
        entry.state.module = require(entry.mainPath);
      }
      const mod = entry.state.module;
      const activate = mod.activate ?? mod.default?.activate;
      const exports = await activate?.call(mod, entry.state.context);
      entry.exports = exports;
      entry.isActive = true;
      entry.state.activatedIn = Date.now() - started;
      this.logger.info(`Activated ${entry.id} ${entry.version} (${reason}, ${entry.state.activatedIn} ms)`);
    } catch (error) {
      entry.state.error = error;
      this.logger.error(`Failed to activate ${entry.id}:`, error);
    }
    return entry.exports;
  }

  trigger(match) {
    const pending = [];
    for (const entry of this.entries.values()) {
      if (entry.state.activation || !entry.mainPath || !this.isEnabled(entry)) continue;
      const event = entry.events.find(match);
      if (event) pending.push(this.activate(entry.id, event));
    }
    return Promise.all(pending);
  }

  startup() {
    const started = this.trigger((event) => STARTUP_EVENTS.has(event));
    if (this.workbench.workspaceRoot) this.onWorkspace(this.workbench.workspaceRoot);
    return started;
  }

  async onWorkspace(root) {
    const pending = [];
    for (const entry of this.entries.values()) {
      if (entry.state.activation || !entry.mainPath || !this.isEnabled(entry)) continue;
      const patterns = entry.events.filter((e) => e.startsWith(WORKSPACE_SCAN_PREFIX)).map((e) => e.slice(WORKSPACE_SCAN_PREFIX.length));
      if (patterns.length) pending.push({ entry, patterns });
    }
    if (!pending.length) return;
    const found = await this.workspaceContains(root, [...new Set(pending.flatMap(({ patterns }) => patterns))]);
    for (const { entry, patterns } of pending) {
      const hit = patterns.find((pattern) => found.has(pattern));
      if (hit) this.activate(entry.id, `${WORKSPACE_SCAN_PREFIX}${hit}`);
    }
  }

  async workspaceContains(root, patterns) {
    const found = new Set();
    const globs = new Set();
    for (const pattern of patterns) {
      const key = `${root}\n${pattern}`;
      if (!this.workspaceScans.has(key) && !/[*?{[]/.test(pattern)) this.workspaceScans.set(key, fs.existsSync(path.join(root, pattern)));
      if (!this.workspaceScans.has(key)) globs.add(pattern);
      else if (this.workspaceScans.get(key)) found.add(pattern);
    }
    if (!globs.size) return found;
    const remaining = new Set(globs);
    const deadline = Date.now() + WORKSPACE_SCAN_MS;
    let complete = true;
    try {
      for await (const file of fs.promises.glob([...globs], { cwd: root, exclude: (p) => IGNORED_DIRS.test(String(p)) || Date.now() > deadline })) {
        const relative = String(file).split(path.sep).join('/');
        for (const pattern of remaining) {
          if (!path.matchesGlob(relative, pattern)) continue;
          remaining.delete(pattern);
          found.add(pattern);
          this.workspaceScans.set(`${root}\n${pattern}`, true);
        }
        if (!remaining.size) break;
      }
    } catch (error) {
      complete = false;
      this.logger.debug(`Project scan of ${root} failed: ${error.message}`);
    }
    if (Date.now() > deadline) complete = false;
    if (complete) for (const pattern of remaining) this.workspaceScans.set(`${root}\n${pattern}`, false);
    return found;
  }

  async deactivateAll() {
    await Promise.allSettled(this.active.map((entry) => this.deactivate(entry)));
  }

  async deactivate(entry) {
    try {
      const mod = entry.state.module;
      await (mod?.deactivate ?? mod?.default?.deactivate)?.call(mod);
    } catch (error) {
      this.logger.warn(`Error while deactivating ${entry.id}:`, error);
    }
    for (const disposable of entry.state.context?.subscriptions ?? []) {
      try {
        disposable?.dispose?.();
      } catch {}
    }
    entry.isActive = false;
  }
}

module.exports = {
  ExtensionHost,
  activationEvents,
  describeActivation,
  discoverAll,
  discoverExtensions,
  installVscodeModule,
  readDisabled,
  resolveMain,
  selectExtensions,
};

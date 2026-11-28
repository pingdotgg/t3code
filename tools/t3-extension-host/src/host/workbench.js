'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const apiTypes = require('./api-types');
const { namespace } = require('./stub');
const types = require('./types');

const {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  Position,
  Range,
  Selection,
  TabInputText,
  TextDocument,
  Uri,
  enums,
  noopEvent,
} = types;

const isWindows = process.platform === 'win32';

// WakaTime only classifies edits as "ai coding" while the active tab looks like Claude Code's chat panel.
const AGENT_TAB = Object.freeze({
  label: 'Claude Code',
  isActive: true,
  isDirty: false,
  isPinned: false,
  isPreview: false,
  input: { viewType: 'mainThreadWebview-claudeVSCodePanel' },
});

function docKey(fsPath) {
  const normalized = path.resolve(fsPath);
  return isWindows ? normalized.toLowerCase() : normalized;
}

function isInside(child, parent) {
  if (!parent) return false;
  const rel = path.relative(docKey(parent), docKey(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function globMatches(fsPath, pattern) {
  try {
    if (typeof pattern === 'string') return path.matchesGlob(fsPath.split(path.sep).join('/'), pattern);
    const base = pattern.baseUri?.fsPath ?? pattern.base;
    return isInside(fsPath, base) && path.matchesGlob(path.relative(base, fsPath).split(path.sep).join('/'), pattern.pattern);
  } catch {
    return false;
  }
}

function createWebview() {
  return {
    html: '',
    options: {},
    cspSource: '',
    onDidReceiveMessage: noopEvent,
    postMessage: async () => false,
    asWebviewUri: (uri) => uri,
  };
}

function createQuickInput(kind, log) {
  const hide = new EventEmitter();
  const input = {
    title: undefined,
    value: '',
    placeholder: undefined,
    items: [],
    activeItems: [],
    selectedItems: [],
    buttons: [],
    busy: false,
    enabled: true,
    ignoreFocusOut: false,
    onDidHide: hide.event,
    show() {
      log.info(`An extension opened a ${kind}, which T3 Extension Host cannot show${this.title ? `: ${this.title}` : ''}`);
      setImmediate(() => hide.fire());
    },
    hide() {
      hide.fire();
    },
    dispose() {
      hide.dispose();
    },
  };
  return namespace(input, kind);
}

class FileMemento {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(key, defaultValue) {
    return Object.hasOwn(this.data, key) ? this.data[key] : defaultValue;
  }

  keys() {
    return Object.keys(this.data);
  }

  update(key, value) {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return Promise.resolve();
  }

  setKeysForSync() {}
}

class Workbench {
  constructor({ appName, version, appRoot, dataDir, sharedGlobalStorage, settings, logger, git }) {
    this.sharedGlobalStorage = sharedGlobalStorage;
    this.appName = appName;
    this.version = version;
    this.appRoot = appRoot;
    this.dataDir = dataDir;
    this.settings = settings;
    this.logger = logger;
    this.git = git;
    this.folders = [];
    this.workspaceName = undefined;
    this.documents = new Map();
    this.activeEditor = undefined;
    this.windowState = { focused: false, active: false };
    this.agentActive = false;
    this.agentEditing = false;
    this.commands = new Map();
    this.extensions = new Map();
    this.statusItems = new Set();
    this.secrets = new Map();
    this.diagnostics = new Set();
    this.watchers = new Set();
    this.terminals = new Set();
    this.onUnknownCommand = null;
    this.emit = {
      activeEditor: new EventEmitter(),
      visibleEditors: new EventEmitter(),
      selection: new EventEmitter(),
      windowState: new EventEmitter(),
      openDocument: new EventEmitter(),
      changeDocument: new EventEmitter(),
      saveDocument: new EventEmitter(),
      folders: new EventEmitter(),
      configuration: new EventEmitter(),
      secrets: new EventEmitter(),
      openTerminal: new EventEmitter(),
      closeTerminal: new EventEmitter(),
    };
    this.api = this.createApi();
    if (git) this.registerExtension(git.extension);
  }

  get activeDocumentPath() {
    return this.activeEditor?.document.fileName;
  }

  get workspaceRoot() {
    return this.folders[0]?.uri.fsPath;
  }

  registerExtension(extension) {
    this.extensions.set(extension.id.toLowerCase(), extension);
    return extension;
  }

  setWorkspace(folder) {
    const previous = this.folders[0];
    if (previous?.uri.fsPath === folder?.root && this.workspaceName === folder?.name) return false;
    const added = folder ? [{ uri: Uri.file(folder.root), name: folder.name, index: 0 }] : [];
    this.folders = added;
    this.workspaceName = folder?.name;
    this.emit.folders.fire({ added, removed: previous ? [previous] : [] });
    this.git?.setRoot(folder?.root ?? null).catch((error) => this.logger.debug(`git lookup failed: ${error.message}`));
    return true;
  }

  setWindowFocused(focused) {
    if (this.windowState.focused === focused) return;
    this.windowState = { focused, active: focused };
    this.emit.windowState.fire(this.windowState);
  }

  setAgentActive(active) {
    this.agentActive = active;
  }

  showDocument(doc, line = 0) {
    const position = new Position(Math.max(0, Math.min(line, doc.lineCount - 1)), 0);
    const selection = new Selection(position, position);
    const editor = {
      document: doc,
      selection,
      selections: [selection],
      visibleRanges: [new Range(position, position)],
      options: { tabSize: 2, insertSpaces: true },
      viewColumn: enums.ViewColumn.One,
      edit: async () => false,
      insertSnippet: async () => false,
      setDecorations() {},
      revealRange() {},
      show() {},
      hide() {},
    };
    this.activeEditor = editor;
    this.emit.visibleEditors.fire([editor]);
    this.emit.activeEditor.fire(editor);
    return editor;
  }

  clearEditor() {
    if (!this.activeEditor) return;
    this.activeEditor = undefined;
    this.emit.visibleEditors.fire([]);
    this.emit.activeEditor.fire(undefined);
  }

  applyAgentEdit(fsPath, text, { previousLineCount, line = 0 } = {}) {
    const key = docKey(fsPath);
    let doc = this.documents.get(key);
    if (!doc) {
      doc = new TextDocument(Uri.file(path.resolve(fsPath)), text);
      if (previousLineCount !== undefined) doc.lineCountOverride = Math.max(1, previousLineCount);
      this.documents.set(key, doc);
      this.emit.openDocument.fire(doc);
    }
    this.agentEditing = true;
    try {
      let editor = this.activeEditor;
      if (editor?.document !== doc) editor = this.showDocument(doc, 0);
      const oldText = doc.getText();
      const oldEnd = new Position(doc.lines.length - 1, doc.lines[doc.lines.length - 1].length);
      doc.lineCountOverride = undefined;
      doc.setText(text);
      doc.version += 1;
      const position = new Position(Math.max(0, Math.min(line, doc.lineCount - 1)), 0);
      editor.selection = new Selection(position, position);
      editor.selections = [editor.selection];
      this.emit.selection.fire({ textEditor: editor, selections: editor.selections, kind: enums.TextEditorSelectionChangeKind.Keyboard });
      this.emit.changeDocument.fire({
        document: doc,
        contentChanges: [{ range: new Range(new Position(0, 0), oldEnd), rangeOffset: 0, rangeLength: oldText.length, text }],
        reason: undefined,
      });
    } finally {
      this.agentEditing = false;
    }
    for (const watcher of this.watchers) watcher.notify(doc.uri, previousLineCount === 0);
  }

  pulse() {
    const editor = this.activeEditor;
    if (!editor) return;
    this.agentEditing = true;
    try {
      this.emit.selection.fire({ textEditor: editor, selections: editor.selections, kind: enums.TextEditorSelectionChangeKind.Keyboard });
    } finally {
      this.agentEditing = false;
    }
  }

  refreshSettings() {
    if (!this.settings.changedOnDisk()) return;
    this.settings.reload();
    this.logger.info('Settings changed on disk; reloaded');
    this.emit.configuration.fire({ affectsConfiguration: () => true });
  }

  async executeCommand(id, ...args) {
    if (!this.commands.has(id) && this.onUnknownCommand) await this.onUnknownCommand(id);
    const command = this.commands.get(id);
    if (command) return command.callback.apply(command.thisArg, args);
    if (id === 'setContext') return undefined;
    this.logger.debug(`Ignoring unknown command ${id}`);
    return undefined;
  }

  getWorkspaceFolder(uri) {
    const fsPath = typeof uri === 'string' ? uri : uri?.fsPath;
    if (!fsPath) return undefined;
    return this.folders.find((folder) => isInside(fsPath, folder.uri.fsPath));
  }

  createContext(extension) {
    const id = extension.id.toLowerCase();
    const storage = path.join(this.dataDir, 'storage', id);
    const globalStorage = path.join(this.sharedGlobalStorage ?? path.join(this.dataDir, 'globalStorage'), id);
    const logs = path.join(this.dataDir, 'logs', id);
    const secrets = this.secrets;
    const secretsChanged = this.emit.secrets;
    const variables = new Map();
    return namespace({
      subscriptions: [],
      extension,
      extensionPath: extension.extensionPath,
      extensionUri: extension.extensionUri,
      asAbsolutePath: (relativePath) => path.join(extension.extensionPath, relativePath),
      extensionMode: enums.ExtensionMode.Production,
      globalState: new FileMemento(path.join(this.dataDir, 'state', `${id}.global.json`)),
      workspaceState: new FileMemento(path.join(this.dataDir, 'state', `${id}.workspace.json`)),
      storagePath: storage,
      storageUri: Uri.file(storage),
      globalStoragePath: globalStorage,
      globalStorageUri: Uri.file(globalStorage),
      logPath: logs,
      logUri: Uri.file(logs),
      secrets: {
        get: async (key) => secrets.get(`${id}:${key}`),
        store: async (key, value) => {
          secrets.set(`${id}:${key}`, value);
          secretsChanged.fire({ key });
        },
        delete: async (key) => {
          secrets.delete(`${id}:${key}`);
          secretsChanged.fire({ key });
        },
        onDidChange: secretsChanged.event,
      },
      environmentVariableCollection: {
        persistent: true,
        description: undefined,
        replace: (name, value) => variables.set(name, value),
        append: (name, value) => variables.set(name, value),
        prepend: (name, value) => variables.set(name, value),
        get: (name) => variables.get(name),
        forEach: (callback) => variables.forEach((value, name) => callback(name, value)),
        delete: (name) => variables.delete(name),
        clear: () => variables.clear(),
        getScoped: () => undefined,
        [Symbol.iterator]: () => variables.entries(),
      },
      languageModelAccessInformation: { onDidChange: noopEvent, canSendRequest: () => undefined },
    }, 'context');
  }

  createDiagnosticCollection(name) {
    const entries = new Map();
    const collection = {
      name,
      set(uriOrEntries, diagnostics) {
        const pairs = Array.isArray(uriOrEntries) ? uriOrEntries : [[uriOrEntries, diagnostics]];
        for (const [uri, list] of pairs) {
          if (list) entries.set(uri.toString(), [uri, list]);
          else entries.delete(uri.toString());
        }
      },
      get: (uri) => entries.get(uri.toString())?.[1],
      has: (uri) => entries.has(uri.toString()),
      delete: (uri) => entries.delete(uri.toString()),
      clear: () => entries.clear(),
      forEach(callback, thisArg) {
        for (const [uri, list] of entries.values()) callback.call(thisArg, uri, list, collection);
      },
      *[Symbol.iterator]() {
        yield* entries.values();
      },
      dispose: () => {
        entries.clear();
        this.diagnostics.delete(collection);
      },
    };
    this.diagnostics.add(collection);
    return collection;
  }

  getDiagnostics(uri) {
    if (uri) return [...this.diagnostics].flatMap((collection) => collection.get(uri) ?? []);
    const byUri = new Map();
    for (const collection of this.diagnostics) {
      for (const [entryUri, list] of collection) {
        const key = entryUri.toString();
        byUri.set(key, [entryUri, [...(byUri.get(key)?.[1] ?? []), ...list]]);
      }
    }
    return [...byUri.values()];
  }

  createFileSystemWatcher(pattern, ignoreCreate = false, ignoreChange = false) {
    const created = new EventEmitter();
    const changed = new EventEmitter();
    const watcher = {
      ignoreCreateEvents: ignoreCreate,
      ignoreChangeEvents: ignoreChange,
      ignoreDeleteEvents: true,
      onDidCreate: created.event,
      onDidChange: changed.event,
      onDidDelete: noopEvent,
      notify: (uri, isNew) => {
        if (!globMatches(uri.fsPath, pattern)) return;
        if (isNew && !ignoreCreate) created.fire(uri);
        else if (!isNew && !ignoreChange) changed.fire(uri);
      },
      dispose: () => this.watchers.delete(watcher),
    };
    this.watchers.add(watcher);
    return watcher;
  }

  createTerminal(nameOrOptions, shellPath, shellArgs) {
    const options = typeof nameOrOptions === 'object' && nameOrOptions ? nameOrOptions : { name: nameOrOptions, shellPath, shellArgs };
    const name = options.name ?? 'Terminal';
    const log = this.logger.child(`terminal:${name}`);
    let child = null;
    const terminal = namespace({
      name,
      creationOptions: options,
      processId: Promise.resolve(undefined),
      exitStatus: undefined,
      state: { isInteractedWith: false },
      shellIntegration: undefined,
      sendText: (text) => log.debug(`Input ignored (no visible terminal): ${String(text).slice(0, 200)}`),
      show() {},
      hide() {},
      dispose: () => {
        if (child && child.exitCode === null) child.kill();
        else if (options.pty) options.pty.close?.();
        close(undefined, 3);
      },
    }, 'Terminal');
    const close = (code, reason = 2) => {
      if (!this.terminals.delete(terminal)) return;
      terminal.exitStatus = { code, reason };
      this.emit.closeTerminal.fire(terminal);
    };

    if (options.pty) {
      options.pty.onDidWrite?.((data) => log.debug(String(data).trim()));
      options.pty.onDidClose?.((code) => close(typeof code === 'number' ? code : undefined));
      terminal.sendText = (text, addNewLine = true) => options.pty.handleInput?.(addNewLine ? `${text}\r` : text);
      setImmediate(() => options.pty.open?.({ columns: 120, rows: 30 }));
    } else if (options.shellPath) {
      const args = typeof options.shellArgs === 'string' ? [options.shellArgs] : (options.shellArgs ?? []);
      const cwd = typeof options.cwd === 'string' ? options.cwd : (options.cwd?.fsPath ?? this.workspaceRoot ?? os.homedir());
      const env = options.strictEnv ? options.env : { ...process.env, ...options.env };
      child = spawn(options.shellPath, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      terminal.processId = new Promise((resolve) => {
        child.once('spawn', () => resolve(child.pid));
        child.once('error', () => resolve(undefined));
      });
      child.on('error', (error) => log.warn(`Could not start ${options.shellPath}: ${error.message}`));
      child.stdin.on('error', (error) => log.debug(`Input not delivered: ${error.message}`));
      child.stdout.on('data', (chunk) => log.debug(String(chunk).trim().slice(0, 500)));
      child.stderr.on('data', (chunk) => log.debug(String(chunk).trim().slice(0, 500)));
      child.on('exit', (code) => close(code ?? undefined));
      terminal.sendText = (text, addNewLine = true) => child.stdin.writable && child.stdin.write(addNewLine ? `${text}${os.EOL}` : text);
      log.info(`Started ${path.basename(options.shellPath)} for an extension`);
    }

    this.terminals.add(terminal);
    this.emit.openTerminal.fire(terminal);
    return terminal;
  }

  disposeTerminals() {
    for (const terminal of [...this.terminals]) terminal.dispose();
  }

  async findFiles(include, exclude, maxResults = Infinity) {
    const relative = typeof include === 'object' && include !== null;
    const cwd = relative ? (include.baseUri?.fsPath ?? include.base) : this.workspaceRoot;
    if (!cwd) return [];
    const pattern = relative ? include.pattern : include;
    const skip = typeof exclude === 'string' ? exclude : null;
    const results = [];
    const deadline = Date.now() + 5000;
    try {
      for await (const file of fs.promises.glob(pattern, {
        cwd,
        exclude: (p) =>
          Date.now() > deadline ||
          /(^|[\\/])(node_modules|bower_components|\.git|\.svn|\.hg)$/.test(String(p)) ||
          (skip ? path.matchesGlob(String(p).split(path.sep).join('/'), skip) : false),
      })) {
        results.push(Uri.file(path.resolve(cwd, file)));
        if (results.length >= maxResults || Date.now() > deadline) break;
      }
    } catch (error) {
      this.logger.debug(`findFiles(${pattern}) failed: ${error.message}`);
    }
    return results;
  }

  createStatusBarItem(idOrAlignment, alignmentOrPriority, maybePriority) {
    const named = typeof idOrAlignment === 'string';
    const statusItems = this.statusItems;
    const item = {
      id: named ? idOrAlignment : undefined,
      alignment: (named ? alignmentOrPriority : idOrAlignment) ?? enums.StatusBarAlignment.Left,
      priority: named ? maybePriority : alignmentOrPriority,
      name: undefined,
      text: '',
      tooltip: undefined,
      color: undefined,
      backgroundColor: undefined,
      command: undefined,
      accessibilityInformation: undefined,
      visible: false,
      show() {
        this.visible = true;
      },
      hide() {
        this.visible = false;
      },
      dispose() {
        this.visible = false;
        statusItems.delete(item);
      },
    };
    statusItems.add(item);
    return item;
  }

  createOutputChannel(name) {
    const log = this.logger.child(name);
    const lineLevel = (line) => (/- (TRACE|DEBUG)\]/.test(line) ? 'debug' : /- (ERROR)\]/.test(line) ? 'warn' : 'info');
    let pending = '';
    const writeLine = (line) => log[lineLevel(line)](line);
    return {
      name,
      logLevel: enums.LogLevel.Info,
      onDidChangeLogLevel: noopEvent,
      append(value) {
        pending += value;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        lines.forEach(writeLine);
      },
      appendLine(value) {
        writeLine(pending + value);
        pending = '';
      },
      replace(value) {
        pending = '';
        this.append(value);
      },
      clear() {},
      show() {},
      hide() {},
      dispose() {},
      trace: (message) => log.debug(message),
      debug: (message) => log.debug(message),
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message) => log.error(message),
    };
  }

  createConfiguration(section) {
    const settings = this.settings;
    const fullKey = (key) => (section ? `${section}.${key}` : key);
    const values = settings.section(section);
    return Object.assign(values, {
      get: (key, defaultValue) => {
        const value = settings.get(fullKey(key));
        return value === undefined ? defaultValue : value;
      },
      has: (key) => settings.get(fullKey(key)) !== undefined,
      inspect: (key) => settings.inspect(fullKey(key)),
      update: async (key, value) => {
        settings.update(fullKey(key), value);
        this.emit.configuration.fire({ affectsConfiguration: (name) => fullKey(key).startsWith(name) });
      },
    });
  }

  openExternal(uri) {
    const target = String(uri);
    if (!/^https?:\/\//i.test(target)) return Promise.resolve(false);
    const [command, args] = isWindows
      ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
    execFile(command, args, { windowsHide: true }, () => {});
    return Promise.resolve(true);
  }

  createApi() {
    const wb = this;
    const log = this.logger.child('vscode');

    const textTab = () => {
      const doc = wb.activeEditor?.document;
      if (!doc) return undefined;
      return { label: path.basename(doc.fileName), isActive: true, isDirty: false, isPinned: false, isPreview: false, input: new TabInputText(doc.uri) };
    };
    const activeTabGroup = {
      isActive: true,
      viewColumn: enums.ViewColumn.One,
      get activeTab() {
        return wb.agentActive || wb.agentEditing ? AGENT_TAB : textTab();
      },
      get tabs() {
        const tab = this.activeTab;
        return tab ? [tab] : [];
      },
    };

    const message = (level) => (text) => {
      log[level](String(text));
      return Promise.resolve(undefined);
    };

    const window = namespace({
      get activeTextEditor() {
        return wb.activeEditor;
      },
      get visibleTextEditors() {
        return wb.activeEditor ? [wb.activeEditor] : [];
      },
      get state() {
        return wb.windowState;
      },
      activeTerminal: undefined,
      activeNotebookEditor: undefined,
      visibleNotebookEditors: [],
      activeColorTheme: { kind: enums.ColorThemeKind.Dark },
      tabGroups: namespace({
        activeTabGroup,
        get all() {
          return [activeTabGroup];
        },
        close: async () => false,
      }, 'window.tabGroups'),
      onDidChangeActiveTextEditor: wb.emit.activeEditor.event,
      onDidChangeVisibleTextEditors: wb.emit.visibleEditors.event,
      onDidChangeTextEditorSelection: wb.emit.selection.event,
      onDidChangeWindowState: wb.emit.windowState.event,
      createStatusBarItem: (...args) => wb.createStatusBarItem(...args),
      createOutputChannel: (name) => wb.createOutputChannel(name),
      showInformationMessage: message('info'),
      showWarningMessage: message('warn'),
      showErrorMessage: message('warn'),
      showQuickPick: async (_items, options) => {
        log.info(`An extension asked for a choice, which T3 Extension Host cannot show${options?.placeHolder ? `: ${options.placeHolder}` : ''}`);
        return undefined;
      },
      showInputBox: async (options) => {
        log.info(`An extension asked for input, which T3 Extension Host cannot show${options?.prompt ? `: ${options.prompt}` : ''}`);
        return undefined;
      },
      setStatusBarMessage: (text) => {
        log.debug(`status: ${text}`);
        return new Disposable(() => {});
      },
      showTextDocument: async (documentOrUri) => {
        log.debug(`showTextDocument ${documentOrUri?.fsPath ?? documentOrUri?.fileName ?? documentOrUri}`);
        return undefined;
      },
      withProgress: async (_options, task) => task({ report() {} }, new CancellationTokenSource().token),
      createTextEditorDecorationType: () => ({ key: crypto.randomUUID(), dispose() {} }),
      showOpenDialog: async () => undefined,
      showSaveDialog: async () => undefined,
      showWorkspaceFolderPick: async () => undefined,
      createQuickPick: () => createQuickInput('quick pick', log),
      createInputBox: () => createQuickInput('input box', log),
      createTerminal: (...args) => wb.createTerminal(...args),
      get terminals() {
        return [...wb.terminals];
      },
      onDidOpenTerminal: wb.emit.openTerminal.event,
      onDidCloseTerminal: wb.emit.closeTerminal.event,
      createWebviewPanel: (viewType, title, _showOptions, options = {}) => {
        const disposed = new EventEmitter();
        log.debug(`Webview panel "${title}" (${viewType}) created but not shown`);
        return namespace({
          viewType,
          title,
          options,
          active: false,
          visible: false,
          viewColumn: undefined,
          iconPath: undefined,
          webview: createWebview(),
          onDidDispose: disposed.event,
          onDidChangeViewState: noopEvent,
          reveal() {},
          dispose: () => disposed.fire(),
        }, 'WebviewPanel');
      },
      createTreeView: (viewId) =>
        namespace({
          id: viewId,
          visible: false,
          selection: [],
          message: undefined,
          title: undefined,
          description: undefined,
          badge: undefined,
          reveal: async () => {},
          dispose() {},
        }, 'TreeView'),
    }, 'window');

    const { FileSystemError } = apiTypes.classes;
    const fsErrorCodes = { ENOENT: 'FileNotFound', EEXIST: 'FileExists', ENOTDIR: 'FileNotADirectory', EISDIR: 'FileIsADirectory', EPERM: 'NoPermissions', EACCES: 'NoPermissions' };
    const fsCall = (operation) => async (uri, ...args) => {
      try {
        return await operation(uri, ...args);
      } catch (error) {
        if (error instanceof FileSystemError) throw error;
        const fsError = new FileSystemError(uri, fsErrorCodes[String(error.code).split('_').pop()] ?? 'Unknown');
        fsError.message = error.message;
        throw fsError;
      }
    };
    const fsApi = namespace({
      stat: fsCall(async (uri) => {
        const stat = await fs.promises.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? enums.FileType.Directory : enums.FileType.File,
          ctime: stat.ctimeMs,
          mtime: stat.mtimeMs,
          size: stat.size,
        };
      }),
      readFile: fsCall((uri) => fs.promises.readFile(uri.fsPath)),
      writeFile: fsCall(async (uri, content) => {
        await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fs.promises.writeFile(uri.fsPath, content);
      }),
      createDirectory: fsCall(async (uri) => {
        await fs.promises.mkdir(uri.fsPath, { recursive: true });
      }),
      readDirectory: fsCall(async (uri) => {
        const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((e) => [e.name, e.isDirectory() ? enums.FileType.Directory : enums.FileType.File]);
      }),
      delete: fsCall((uri, options) => fs.promises.rm(uri.fsPath, { recursive: Boolean(options?.recursive), force: true })),
      rename: fsCall(async (source, target, options) => {
        if (!options?.overwrite && fs.existsSync(target.fsPath)) throw FileSystemError.FileExists(target);
        await fs.promises.rename(source.fsPath, target.fsPath);
      }),
      copy: fsCall((source, target, options) => fs.promises.cp(source.fsPath, target.fsPath, { recursive: true, force: Boolean(options?.overwrite), errorOnExist: !options?.overwrite })),
      isWritableFileSystem: () => true,
    }, 'workspace.fs');

    const workspace = namespace({
      get workspaceFolders() {
        return wb.folders.length ? wb.folders : undefined;
      },
      get name() {
        return wb.workspaceName;
      },
      get rootPath() {
        return wb.workspaceRoot;
      },
      workspaceFile: undefined,
      isTrusted: true,
      get textDocuments() {
        return [...wb.documents.values()];
      },
      fs: fsApi,
      getConfiguration: (section) => wb.createConfiguration(section),
      getWorkspaceFolder: (uri) => wb.getWorkspaceFolder(uri),
      asRelativePath: (pathOrUri, includeWorkspaceFolder) => {
        const fsPath = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
        const folder = wb.getWorkspaceFolder(fsPath);
        if (!folder) return fsPath;
        const rel = path.relative(folder.uri.fsPath, fsPath).split(path.sep).join('/');
        return includeWorkspaceFolder && wb.folders.length > 1 ? `${folder.name}/${rel}` : rel;
      },
      openTextDocument: async (target) => {
        if (!target || (typeof target === 'object' && !(target instanceof Uri) && !target.fsPath)) {
          const doc = new TextDocument(Uri.from({ scheme: 'untitled', path: `Untitled-${crypto.randomUUID()}` }), target?.content ?? '');
          doc.isUntitled = true;
          if (target?.language) doc.languageId = target.language;
          return doc;
        }
        const fsPath = typeof target === 'string' ? target : target.fsPath;
        const existing = wb.documents.get(docKey(fsPath));
        if (existing) return existing;
        return new TextDocument(Uri.file(fsPath), await fs.promises.readFile(fsPath, 'utf8'));
      },
      notebookDocuments: [],
      findFiles: (include, exclude, maxResults) => wb.findFiles(include, exclude, maxResults),
      saveAll: async () => true,
      applyEdit: async () => false,
      createFileSystemWatcher: (pattern, ignoreCreate, ignoreChange) => wb.createFileSystemWatcher(pattern, ignoreCreate, ignoreChange),
      onDidOpenTextDocument: wb.emit.openDocument.event,
      onDidChangeTextDocument: wb.emit.changeDocument.event,
      onDidSaveTextDocument: wb.emit.saveDocument.event,
      onDidChangeWorkspaceFolders: wb.emit.folders.event,
      onDidChangeConfiguration: wb.emit.configuration.event,
    }, 'workspace');

    const commands = namespace({
      registerCommand: (id, callback, thisArg) => {
        wb.commands.set(id, { callback, thisArg });
        return new Disposable(() => wb.commands.delete(id));
      },
      registerTextEditorCommand: (id, callback, thisArg) => {
        wb.commands.set(id, { callback: (...args) => callback.call(thisArg, wb.activeEditor, undefined, ...args) });
        return new Disposable(() => wb.commands.delete(id));
      },
      executeCommand: (id, ...args) => wb.executeCommand(id, ...args),
      getCommands: async () => [...wb.commands.keys()],
    }, 'commands');

    const machineId = crypto.createHash('sha256').update(`${os.hostname()}:${os.userInfo().username}`).digest('hex');
    const env = namespace({
      appName: wb.appName,
      appRoot: wb.appRoot,
      appHost: 'desktop',
      uriScheme: 't3code',
      language: 'en',
      machineId,
      sessionId: `${crypto.randomUUID()}${Date.now()}`,
      isNewAppInstall: false,
      isTelemetryEnabled: false,
      remoteName: undefined,
      shell: isWindows ? 'powershell.exe' : process.env.SHELL ?? '/bin/sh',
      uiKind: enums.UIKind.Desktop,
      logLevel: enums.LogLevel.Info,
      clipboard: { readText: async () => '', writeText: async () => {} },
      openExternal: (uri) => wb.openExternal(uri),
      asExternalUri: async (uri) => uri,
      remoteAuthority: undefined,
      isAppPortable: false,
    }, 'env');

    const extensions = namespace({
      getExtension: (id) => wb.extensions.get(String(id).toLowerCase()),
      get all() {
        return [...wb.extensions.values()];
      },
      allAcrossExtensionHosts: [],
    }, 'extensions');

    return namespace({
      ...types.enums,
      ...apiTypes.enums,
      ...apiTypes.classes,
      ...apiTypes.constants,
      CancellationTokenSource,
      Disposable,
      EventEmitter,
      MarkdownString: types.MarkdownString,
      Position,
      Range,
      RelativePattern: types.RelativePattern,
      Selection,
      TabInputText,
      ThemeColor: types.ThemeColor,
      ThemeIcon: types.ThemeIcon,
      Uri,
      version: wb.version,
      env,
      window,
      workspace,
      commands,
      extensions,
      debug: namespace({ activeDebugSession: undefined, activeDebugConsole: { append() {}, appendLine() {} }, breakpoints: [] }, 'debug'),
      tasks: namespace({ taskExecutions: [], fetchTasks: async () => [] }, 'tasks'),
      languages: namespace({
        createDiagnosticCollection: (name) => wb.createDiagnosticCollection(name),
        getDiagnostics: (uri) => wb.getDiagnostics(uri),
        getLanguages: async () => types.languageIds(),
        setTextDocumentLanguage: async (doc, languageId) => {
          doc.languageId = languageId;
          return doc;
        },
        setLanguageConfiguration: () => new Disposable(() => {}),
        match: (selector, doc) => {
          const selectors = [].concat(selector);
          return selectors.some((s) => s === '*' || s === doc.languageId || s?.language === doc.languageId || (s && !s.language && s.scheme === doc.uri.scheme)) ? 10 : 0;
        },
      }, 'languages'),
      lm: namespace({ selectChatModels: async () => [], tools: [] }, 'lm'),
      chat: namespace({}, 'chat'),
      scm: namespace({ inputBox: undefined }, 'scm'),
      notebooks: namespace({}, 'notebooks'),
      tests: namespace({}, 'tests'),
      comments: namespace({}, 'comments'),
      authentication: namespace({ getSession: async () => undefined, getAccounts: async () => [] }, 'authentication'),
      l10n: namespace({
        bundle: undefined,
        uri: undefined,
        t: (message, ...args) => {
          const text = String(typeof message === 'object' ? message.message : message);
          const values = typeof message === 'object' ? (message.args ?? {}) : typeof args[0] === 'object' && args[0] !== null ? args[0] : args;
          return text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);
        },
      }, 'l10n'),
    }, '');
  }
}

module.exports = { Workbench, isInside };

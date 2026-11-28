'use strict';

const path = require('node:path');

const isWindows = process.platform === 'win32';

let reportError = (error) => console.error(error);

function setErrorReporter(fn) {
  reportError = fn;
}

class Disposable {
  constructor(callOnDispose) {
    this._callOnDispose = callOnDispose;
  }

  static from(...disposables) {
    return new Disposable(() => {
      for (const d of disposables) d?.dispose?.();
    });
  }

  dispose() {
    const fn = this._callOnDispose;
    this._callOnDispose = undefined;
    fn?.();
  }
}

function track(disposable, disposables) {
  if (Array.isArray(disposables)) disposables.push(disposable);
  return disposable;
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener, thisArg, disposables) => {
      const entry = { listener, thisArg };
      this._listeners.add(entry);
      return track(new Disposable(() => this._listeners.delete(entry)), disposables);
    };
  }

  fire(data) {
    for (const { listener, thisArg } of [...this._listeners]) {
      try {
        const result = listener.call(thisArg, data);
        if (result && typeof result.catch === 'function') result.catch(reportError);
      } catch (error) {
        reportError(error);
      }
    }
  }

  dispose() {
    this._listeners.clear();
  }
}

function noopEvent(_listener, _thisArg, disposables) {
  return track(new Disposable(() => {}), disposables);
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

class Uri {
  constructor(scheme, authority, uriPath, query, fragment) {
    if (scheme && typeof scheme === 'object') ({ scheme, authority, path: uriPath, query, fragment } = scheme);
    this.scheme = scheme || 'file';
    this.authority = authority || '';
    this.path = uriPath || '/';
    this.query = query || '';
    this.fragment = fragment || '';
  }

  static file(fsPath) {
    let p = String(fsPath);
    if (isWindows) p = p.replace(/\\/g, '/');
    let authority = '';
    if (p.startsWith('//')) {
      const end = p.indexOf('/', 2);
      authority = end === -1 ? p.slice(2) : p.slice(2, end);
      p = end === -1 ? '/' : p.slice(end);
    }
    if (!p.startsWith('/')) p = `/${p}`;
    return new Uri('file', authority, p, '', '');
  }

  static parse(value) {
    const text = String(value);
    const match = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(text);
    if (!match || (isWindows && match[1].length === 1)) return Uri.file(text);
    return new Uri(match[1].toLowerCase(), decode(match[2] || ''), decode(match[3] || '/'), match[4], match[5]);
  }

  static from(components) {
    return new Uri(components.scheme, components.authority, components.path, components.query, components.fragment);
  }

  static joinPath(base, ...segments) {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }

  get fsPath() {
    let p = this.path;
    if (this.scheme === 'file' && this.authority) p = `//${this.authority}${p}`;
    else if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return isWindows ? p.replace(/\//g, '\\') : p;
  }

  with(change = {}) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString() {
    const authority = this.authority || this.scheme === 'file' ? `//${encodeURIComponent(this.authority)}` : '';
    const uriPath = this.scheme === 'file' ? this.path.replace(/^\/([A-Z]):/, (_, drive) => `/${drive.toLowerCase()}:`) : this.path;
    const encodedPath = uriPath.split('/').map(encodeURIComponent).join('/');
    const query = this.query ? `?${this.query}` : '';
    const fragment = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}:${authority}${encodedPath}${query}${fragment}`;
  }

  toJSON() {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath };
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }

  compareTo(other) {
    return this.line - other.line || this.character - other.character;
  }

  isBefore(other) {
    return this.compareTo(other) < 0;
  }

  isBeforeOrEqual(other) {
    return this.compareTo(other) <= 0;
  }

  isAfter(other) {
    return this.compareTo(other) > 0;
  }

  isAfterOrEqual(other) {
    return this.compareTo(other) >= 0;
  }

  isEqual(other) {
    return this.compareTo(other) === 0;
  }

  translate(lineDelta = 0, characterDelta = 0) {
    if (typeof lineDelta === 'object') return this.translate(lineDelta.lineDelta, lineDelta.characterDelta);
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  with(line = this.line, character = this.character) {
    if (typeof line === 'object') return new Position(line.line ?? this.line, line.character ?? this.character);
    return new Position(line, character);
  }
}

class Range {
  constructor(startOrLine, endOrCharacter, endLine, endCharacter) {
    let start = startOrLine;
    let end = endOrCharacter;
    if (typeof startOrLine === 'number') {
      start = new Position(startOrLine, endOrCharacter);
      end = new Position(endLine, endCharacter);
    }
    if (end.isBefore(start)) [start, end] = [end, start];
    this.start = start;
    this.end = end;
  }

  get isEmpty() {
    return this.start.isEqual(this.end);
  }

  get isSingleLine() {
    return this.start.line === this.end.line;
  }

  contains(value) {
    if (value instanceof Range) return this.contains(value.start) && this.contains(value.end);
    return value.isAfterOrEqual(this.start) && value.isBeforeOrEqual(this.end);
  }

  isEqual(other) {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(other) {
    const start = other.start.isAfter(this.start) ? other.start : this.start;
    const end = other.end.isBefore(this.end) ? other.end : this.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }

  union(other) {
    const start = other.start.isBefore(this.start) ? other.start : this.start;
    const end = other.end.isAfter(this.end) ? other.end : this.end;
    return new Range(start, end);
  }

  with(start = this.start, end = this.end) {
    if (start && !(start instanceof Position)) return new Range(start.start ?? this.start, start.end ?? this.end);
    return new Range(start, end);
  }
}

class Selection extends Range {
  constructor(anchorOrLine, activeOrCharacter, activeLine, activeCharacter) {
    let anchor = anchorOrLine;
    let active = activeOrCharacter;
    if (typeof anchorOrLine === 'number') {
      anchor = new Position(anchorOrLine, activeOrCharacter);
      active = new Position(activeLine, activeCharacter);
    }
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }

  get isReversed() {
    return this.anchor.isAfter(this.active);
  }
}

const LANGUAGE_IDS = {
  '.astro': 'astro', '.bat': 'bat', '.c': 'c', '.cc': 'cpp', '.cjs': 'javascript', '.cmd': 'bat', '.cpp': 'cpp',
  '.cs': 'csharp', '.css': 'css', '.cts': 'typescript', '.cxx': 'cpp', '.dart': 'dart', '.go': 'go', '.h': 'c',
  '.hpp': 'cpp', '.html': 'html', '.java': 'java', '.js': 'javascript', '.json': 'json', '.jsonc': 'jsonc',
  '.jsx': 'javascriptreact', '.kt': 'kotlin', '.less': 'less', '.lua': 'lua', '.md': 'markdown', '.mdx': 'mdx',
  '.mjs': 'javascript', '.mts': 'typescript', '.php': 'php', '.prisma': 'prisma', '.ps1': 'powershell',
  '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.scss': 'scss', '.sh': 'shellscript', '.sql': 'sql',
  '.svelte': 'svelte', '.swift': 'swift', '.toml': 'toml', '.ts': 'typescript', '.tsx': 'typescriptreact',
  '.txt': 'plaintext', '.vue': 'vue', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.zig': 'zig',
};

const contributedExtensions = new Map();
const contributedFilenames = new Map();
const knownLanguages = new Set(Object.values(LANGUAGE_IDS));

function registerLanguages(packageJSON) {
  for (const language of packageJSON?.contributes?.languages ?? []) {
    if (!language?.id) continue;
    knownLanguages.add(language.id);
    for (const ext of language.extensions ?? []) {
      if (!contributedExtensions.has(ext.toLowerCase())) contributedExtensions.set(ext.toLowerCase(), language.id);
    }
    for (const name of language.filenames ?? []) {
      if (!contributedFilenames.has(name.toLowerCase())) contributedFilenames.set(name.toLowerCase(), language.id);
    }
  }
}

function languageIdFor(fileName) {
  const base = path.basename(fileName).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  if (contributedFilenames.has(base)) return contributedFilenames.get(base);
  const ext = path.extname(base);
  return LANGUAGE_IDS[ext] ?? contributedExtensions.get(ext) ?? 'plaintext';
}

function languageIds() {
  return [...knownLanguages];
}

class TextDocument {
  constructor(uri, text) {
    this.uri = uri;
    this.fileName = uri.fsPath;
    this.languageId = languageIdFor(this.fileName);
    this.version = 1;
    this.isUntitled = false;
    this.isDirty = false;
    this.isClosed = false;
    this.encoding = 'utf8';
    this.lineCountOverride = undefined;
    this.setText(text);
  }

  setText(text) {
    this.text = text;
    this.lines = text.split(/\r\n|\r|\n/);
    this.eol = text.includes('\r\n') ? 2 : 1;
  }

  get lineCount() {
    return this.lineCountOverride ?? this.lines.length;
  }

  lineAt(lineOrPosition) {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
    const text = this.lines[line] ?? '';
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
      firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
      isEmptyOrWhitespace: text.trim().length === 0,
    };
  }

  offsetAt(position) {
    let offset = 0;
    const newline = this.eol === 2 ? 2 : 1;
    for (let i = 0; i < position.line && i < this.lines.length; i++) offset += this.lines[i].length + newline;
    return offset + position.character;
  }

  positionAt(offset) {
    const before = this.text.slice(0, Math.max(0, offset)).split(/\r\n|\r|\n/);
    return new Position(before.length - 1, before[before.length - 1].length);
  }

  getText(range) {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  getWordRangeAtPosition() {
    return undefined;
  }

  validateRange(range) {
    return range;
  }

  validatePosition(position) {
    return position;
  }

  save() {
    return Promise.resolve(true);
  }
}

class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
    this.isTrusted = false;
  }

  appendText(value) {
    this.value += value;
    return this;
  }

  appendMarkdown(value) {
    this.value += value;
    return this;
  }

  appendCodeblock(code, language = '') {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class CancellationTokenSource {
  constructor() {
    const emitter = new EventEmitter();
    this._emitter = emitter;
    this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
  }

  cancel() {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this._emitter.fire();
  }

  dispose() {
    this._emitter.dispose();
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base.uri ?? base;
    this.base = this.baseUri.fsPath;
    this.pattern = pattern;
  }
}

const enums = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  EndOfLine: { LF: 1, CRLF: 2 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  UIKind: { Desktop: 1, Web: 2 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
};

module.exports = {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  MarkdownString,
  Position,
  Range,
  RelativePattern,
  Selection,
  TabInputText,
  TextDocument,
  ThemeColor,
  ThemeIcon,
  Uri,
  enums,
  languageIdFor,
  languageIds,
  noopEvent,
  registerLanguages,
  setErrorReporter,
  track,
};

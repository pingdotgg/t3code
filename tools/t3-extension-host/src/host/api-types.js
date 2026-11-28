'use strict';

const { Position, Range, Uri, noopEvent } = require('./types');

function dataClass(name, fields, defaults = {}) {
  return {
    [name]: class {
      constructor(...args) {
        fields.forEach((field, i) => {
          const fallback = defaults[field];
          this[field] = args[i] !== undefined ? args[i] : typeof fallback === 'function' ? fallback() : fallback;
        });
      }
    },
  }[name];
}

const list = () => [];

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
  }
}

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }

  static replace(range, newText) {
    return new TextEdit(range, newText);
  }

  static insert(position, newText) {
    return new TextEdit(new Range(position, position), newText);
  }

  static delete(range) {
    return new TextEdit(range, '');
  }

  static setEndOfLine(eol) {
    const edit = new TextEdit(new Range(0, 0, 0, 0), '');
    edit.newEol = eol;
    return edit;
  }
}

class WorkspaceEdit {
  constructor() {
    this._edits = new Map();
    this._files = [];
  }

  _list(uri) {
    const key = uri.toString();
    if (!this._edits.has(key)) this._edits.set(key, [uri, []]);
    return this._edits.get(key)[1];
  }

  get size() {
    return this._edits.size + this._files.length;
  }

  replace(uri, range, newText) {
    this._list(uri).push(new TextEdit(range, newText));
  }

  insert(uri, position, newText) {
    this._list(uri).push(TextEdit.insert(position, newText));
  }

  delete(uri, range) {
    this._list(uri).push(TextEdit.delete(range));
  }

  set(uri, edits) {
    this._edits.set(uri.toString(), [uri, [...(edits ?? [])]]);
  }

  has(uri) {
    return this._edits.has(uri.toString());
  }

  get(uri) {
    return this._edits.get(uri.toString())?.[1] ?? [];
  }

  entries() {
    return [...this._edits.values()];
  }

  createFile(uri, options) {
    this._files.push({ type: 'create', uri, options });
  }

  deleteFile(uri, options) {
    this._files.push({ type: 'delete', uri, options });
  }

  renameFile(oldUri, newUri, options) {
    this._files.push({ type: 'rename', oldUri, newUri, options });
  }
}

class SnippetString {
  constructor(value = '') {
    this.value = value;
    this._tabstop = 1;
  }

  appendText(text) {
    this.value += text.replace(/[$}\\]/g, '\\$&');
    return this;
  }

  appendTabstop(number = this._tabstop++) {
    this.value += `$${number}`;
    return this;
  }

  appendPlaceholder(value, number = this._tabstop++) {
    const inner = typeof value === 'function' ? (value(new SnippetString()).value ?? '') : value;
    this.value += `\${${number}:${inner}}`;
    return this;
  }

  appendChoice(values, number = this._tabstop++) {
    this.value += `\${${number}|${values.join(',')}|}`;
    return this;
  }

  appendVariable(name, defaultValue) {
    this.value += defaultValue === undefined ? `\${${name}}` : `\${${name}:${defaultValue}}`;
    return this;
  }
}

class CodeActionKind {
  constructor(value) {
    this.value = value;
  }

  append(part) {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }

  contains(other) {
    return this.value === other.value || other.value.startsWith(`${this.value}.`);
  }

  intersects(other) {
    return this.contains(other) || other.contains(this);
  }
}
CodeActionKind.Empty = new CodeActionKind('');
for (const [key, value] of Object.entries({
  QuickFix: 'quickfix',
  Refactor: 'refactor',
  RefactorExtract: 'refactor.extract',
  RefactorInline: 'refactor.inline',
  RefactorMove: 'refactor.move',
  RefactorRewrite: 'refactor.rewrite',
  Source: 'source',
  SourceOrganizeImports: 'source.organizeImports',
  SourceFixAll: 'source.fixAll',
  Notebook: 'notebook',
})) {
  CodeActionKind[key] = new CodeActionKind(value);
}

class SemanticTokens {
  constructor(data, resultId) {
    this.data = data;
    this.resultId = resultId;
  }
}

class SemanticTokensBuilder {
  constructor(legend) {
    this.legend = legend;
    this._data = [];
  }

  push(...args) {
    this._data.push(...(args[0] instanceof Range ? [args[0].start.line, args[0].start.character, 0, 0, 0] : args));
  }

  build(resultId) {
    return new SemanticTokens(Uint32Array.from(this._data), resultId);
  }
}

class TaskGroup {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.isDefault = false;
  }
}
TaskGroup.Clean = new TaskGroup('clean', 'Clean');
TaskGroup.Build = new TaskGroup('build', 'Build');
TaskGroup.Rebuild = new TaskGroup('rebuild', 'Rebuild');
TaskGroup.Test = new TaskGroup('test', 'Test');

class FileSystemError extends Error {
  constructor(messageOrUri, code = 'Unknown') {
    super(String(messageOrUri instanceof Uri ? messageOrUri.fsPath : (messageOrUri ?? code)));
    this.name = `${code} (FileSystemError)`;
    this.code = code;
  }
}
for (const code of ['FileNotFound', 'FileExists', 'FileNotADirectory', 'FileIsADirectory', 'NoPermissions', 'Unavailable']) {
  FileSystemError[code] = (messageOrUri) => new FileSystemError(messageOrUri, code);
}

class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

class DataTransferItem {
  constructor(value) {
    this.value = value;
  }

  async asString() {
    return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
  }

  asFile() {
    return undefined;
  }
}

class DataTransfer {
  constructor() {
    this._items = new Map();
  }

  get(mimeType) {
    return this._items.get(mimeType.toLowerCase());
  }

  set(mimeType, value) {
    this._items.set(mimeType.toLowerCase(), value);
  }

  forEach(callback, thisArg) {
    for (const [mime, item] of this._items) callback.call(thisArg, item, mime, this);
  }

  *[Symbol.iterator]() {
    yield* this._items;
  }
}

const classes = {
  Location,
  TextEdit,
  WorkspaceEdit,
  SnippetString,
  CodeActionKind,
  SemanticTokens,
  SemanticTokensBuilder,
  TaskGroup,
  FileSystemError,
  CancellationError,
  DataTransfer,
  DataTransferItem,
  Diagnostic: dataClass('Diagnostic', ['range', 'message', 'severity'], { severity: 0 }),
  DiagnosticRelatedInformation: dataClass('DiagnosticRelatedInformation', ['location', 'message']),
  CompletionItem: dataClass('CompletionItem', ['label', 'kind']),
  CompletionList: dataClass('CompletionList', ['items', 'isIncomplete'], { items: list, isIncomplete: false }),
  Hover: dataClass('Hover', ['contents', 'range']),
  CodeLens: dataClass('CodeLens', ['range', 'command']),
  CodeAction: dataClass('CodeAction', ['title', 'kind']),
  DocumentSymbol: dataClass('DocumentSymbol', ['name', 'detail', 'kind', 'range', 'selectionRange', 'children'], { children: list }),
  SymbolInformation: dataClass('SymbolInformation', ['name', 'kind', 'containerName', 'location']),
  FoldingRange: dataClass('FoldingRange', ['start', 'end', 'kind']),
  DocumentLink: dataClass('DocumentLink', ['range', 'target']),
  DocumentHighlight: dataClass('DocumentHighlight', ['range', 'kind'], { kind: 0 }),
  Color: dataClass('Color', ['red', 'green', 'blue', 'alpha']),
  ColorInformation: dataClass('ColorInformation', ['range', 'color']),
  ColorPresentation: dataClass('ColorPresentation', ['label']),
  SelectionRange: dataClass('SelectionRange', ['range', 'parent']),
  SignatureHelp: dataClass('SignatureHelp', ['signatures', 'activeSignature', 'activeParameter'], { signatures: list, activeSignature: 0, activeParameter: 0 }),
  SignatureInformation: dataClass('SignatureInformation', ['label', 'documentation', 'parameters'], { parameters: list }),
  ParameterInformation: dataClass('ParameterInformation', ['label', 'documentation']),
  InlayHint: dataClass('InlayHint', ['position', 'label', 'kind']),
  InlayHintLabelPart: dataClass('InlayHintLabelPart', ['value']),
  InlineCompletionItem: dataClass('InlineCompletionItem', ['insertText', 'range', 'command']),
  InlineCompletionList: dataClass('InlineCompletionList', ['items'], { items: list }),
  CallHierarchyItem: dataClass('CallHierarchyItem', ['kind', 'name', 'detail', 'uri', 'range', 'selectionRange']),
  TypeHierarchyItem: dataClass('TypeHierarchyItem', ['kind', 'name', 'detail', 'uri', 'range', 'selectionRange']),
  LinkedEditingRanges: dataClass('LinkedEditingRanges', ['ranges', 'wordPattern']),
  EvaluatableExpression: dataClass('EvaluatableExpression', ['range', 'expression']),
  SemanticTokensLegend: dataClass('SemanticTokensLegend', ['tokenTypes', 'tokenModifiers'], { tokenModifiers: list }),
  SemanticTokensEdit: dataClass('SemanticTokensEdit', ['start', 'deleteCount', 'data']),
  SemanticTokensEdits: dataClass('SemanticTokensEdits', ['edits', 'resultId']),
  TreeItem: dataClass('TreeItem', ['label', 'collapsibleState'], { collapsibleState: 0 }),
  Task: dataClass('Task', ['definition', 'scope', 'name', 'source', 'execution', 'problemMatchers'], { problemMatchers: list }),
  ShellExecution: dataClass('ShellExecution', ['commandLine', 'args', 'options']),
  ProcessExecution: dataClass('ProcessExecution', ['process', 'args', 'options']),
  CustomExecution: dataClass('CustomExecution', ['callback']),
  Breakpoint: dataClass('Breakpoint', ['enabled', 'condition', 'hitCondition', 'logMessage']),
  SourceBreakpoint: dataClass('SourceBreakpoint', ['location', 'enabled', 'condition', 'hitCondition', 'logMessage']),
  FunctionBreakpoint: dataClass('FunctionBreakpoint', ['functionName', 'enabled', 'condition', 'hitCondition', 'logMessage']),
  DebugAdapterExecutable: dataClass('DebugAdapterExecutable', ['command', 'args', 'options']),
  DebugAdapterServer: dataClass('DebugAdapterServer', ['port', 'host']),
  DebugAdapterInlineImplementation: dataClass('DebugAdapterInlineImplementation', ['implementation']),
  TerminalLink: dataClass('TerminalLink', ['startIndex', 'length', 'tooltip']),
  TerminalProfile: dataClass('TerminalProfile', ['options']),
  NotebookCellData: dataClass('NotebookCellData', ['kind', 'value', 'languageId']),
  NotebookData: dataClass('NotebookData', ['cells']),
  NotebookRange: dataClass('NotebookRange', ['start', 'end']),
  NotebookCellOutput: dataClass('NotebookCellOutput', ['items', 'metadata']),
  NotebookCellOutputItem: dataClass('NotebookCellOutputItem', ['data', 'mime']),
  TestMessage: dataClass('TestMessage', ['message']),
  TestTag: dataClass('TestTag', ['id']),
  TabInputTextDiff: dataClass('TabInputTextDiff', ['original', 'modified']),
  TabInputCustom: dataClass('TabInputCustom', ['uri', 'viewType']),
  TabInputWebview: dataClass('TabInputWebview', ['viewType']),
  TabInputNotebook: dataClass('TabInputNotebook', ['uri', 'notebookType']),
  TabInputTerminal: dataClass('TabInputTerminal', []),
  LanguageModelTextPart: dataClass('LanguageModelTextPart', ['value']),
  LanguageModelToolResult: dataClass('LanguageModelToolResult', ['content']),
};

const enums = {
  CompletionItemKind: ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter', 'User', 'Issue'],
  SymbolKind: ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'],
  TreeItemCollapsibleState: ['None', 'Collapsed', 'Expanded'],
  DocumentHighlightKind: ['Text', 'Read', 'Write'],
  CompletionTriggerKind: ['Invoke', 'TriggerCharacter', 'TriggerForIncompleteCompletions'],
  InlineCompletionTriggerKind: ['Invoke', 'Automatic'],
  IndentAction: ['None', 'Indent', 'IndentOutdent', 'Outdent'],
  DecorationRangeBehavior: ['OpenOpen', 'ClosedClosed', 'OpenClosed', 'ClosedOpen'],
  TextEditorLineNumbersStyle: ['Off', 'On', 'Relative'],
  CommentMode: ['Editing', 'Preview'],
  CommentThreadCollapsibleState: ['Collapsed', 'Expanded'],
  LanguageStatusSeverity: ['Information', 'Warning', 'Error'],
  DebugConsoleMode: ['Separate', 'MergeWithParent'],
};
const numbered = {
  SignatureHelpTriggerKind: { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 },
  CompletionItemTag: { Deprecated: 1 },
  SymbolTag: { Deprecated: 1 },
  DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  TextEditorCursorStyle: { Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 },
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  TaskScope: { Global: 1, Workspace: 2 },
  ShellQuoting: { Escape: 1, Strong: 2, Weak: 3 },
  TerminalLocation: { Panel: 1, Editor: 2 },
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
  InlayHintKind: { Type: 1, Parameter: 2 },
  CodeActionTriggerKind: { Invoke: 1, Automatic: 2 },
  FoldingRangeKind: { Comment: 1, Imports: 2, Region: 3 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FilePermission: { Readonly: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  EnvironmentVariableMutatorType: { Replace: 1, Append: 2, Prepend: 3 },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  ChatResultFeedbackKind: { Unhelpful: 0, Helpful: 1 },
};
for (const [name, members] of Object.entries(enums)) {
  numbered[name] = Object.fromEntries(members.map((member, i) => [member, i]));
}

const constants = {
  CancellationToken: Object.freeze({
    None: Object.freeze({ isCancellationRequested: false, onCancellationRequested: noopEvent }),
    Cancelled: Object.freeze({ isCancellationRequested: true, onCancellationRequested: noopEvent }),
  }),
  QuickInputButtons: { Back: { iconPath: { id: 'arrow-left' } } },
};

module.exports = { classes, constants, enums: numbered };

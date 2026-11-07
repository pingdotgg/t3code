import { initVim, type CM5EditorInterface, type Pos as VimPos } from "@replit/codemirror-vim-core";

import { isMacPlatform } from "~/lib/utils";

export type VimMode = "insert" | "normal" | "visual" | "visual line" | "replace";

export const INDENT = "  ";
const BRACKET_PAIRS = ["()", "[]", "{}"];
const NOTIFICATION_DURATION = 5000;
// Ctrl+letter is the app's own modifier off macOS, so only these reach the engine there.
const PORTABLE_CTRL_KEYS = new Set(["<C-r>", "<C-d>", "<C-u>"]);
const HOST_OWNED_KEYS = new Set(["<PageUp>", "<PageDown>", "<Tab>", "<S-Tab>"]);
// Native on macOS these do nothing, and the rest stay emacs-style caret keys.
const MAC_INSERT_CTRL_KEYS = new Set([
  "<C-w>",
  "<C-u>",
  "<C-o>",
  "<C-r>",
  "<C-t>",
  "<C-d>",
  "<C-c>",
]);
const CARET_KEYS = /^<(Left|Right|Up|Down|Home|End)>$/;
const WORD_CHARACTER = /[\w\p{Alphabetic}\p{Number}]/u;
export const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Handler = (...args: never[]) => unknown;
type Emitter = EventTarget | { _handlers?: Record<string, Handler[]> };

function on(emitter: Emitter, type: string, handler: Handler) {
  // The engine's paste hook assumes CodeMirror's input model and would jump to insert mode.
  if (type === "paste") return;
  if ("addEventListener" in emitter) {
    emitter.addEventListener(type, handler as unknown as EventListener);
    return;
  }
  const handlers = (emitter._handlers ??= {});
  handlers[type] = [...(handlers[type] ?? []), handler];
}

function off(emitter: Emitter, type: string, handler: Handler) {
  if ("removeEventListener" in emitter) {
    emitter.removeEventListener(type, handler as unknown as EventListener);
    return;
  }
  const handlers = emitter._handlers;
  if (handlers?.[type]) handlers[type] = handlers[type].filter((entry) => entry !== handler);
}

function signal(
  emitter: { _handlers?: Record<string, Handler[]> },
  type: string,
  ...args: unknown[]
) {
  for (const handler of emitter._handlers?.[type] ?? []) {
    (handler as (...values: unknown[]) => unknown)(...args);
  }
}

function runHandlers(handlers: ReadonlyArray<Handler> | undefined, ...args: unknown[]) {
  for (const handler of handlers ?? []) {
    (handler as (...values: unknown[]) => unknown)(...args);
  }
}

export class Pos implements VimPos {
  sticky?: string;
  constructor(
    public line: number,
    public ch: number,
    sticky?: string,
  ) {
    if (sticky !== undefined) this.sticky = sticky;
  }
}

/** The small slice of CodeMirror's stream the engine's ex parser reads. */
class StringStream {
  pos = 0;
  start = 0;
  constructor(public string: string) {}
  eol() {
    return this.pos >= this.string.length;
  }
  sol() {
    return this.pos === 0;
  }
  peek() {
    return this.string.charAt(this.pos) || undefined;
  }
  next() {
    return this.pos < this.string.length ? this.string.charAt(this.pos++) : undefined;
  }
  eat(match: string | RegExp | ((character: string) => boolean)) {
    const character = this.string.charAt(this.pos);
    const ok =
      typeof match === "string"
        ? character === match
        : character !== "" && (match instanceof RegExp ? match.test(character) : match(character));
    if (!ok) return undefined;
    this.pos += 1;
    return character;
  }
  eatWhile(match: string | RegExp | ((character: string) => boolean)) {
    const start = this.pos;
    while (this.eat(match)) {
      // eat advances the stream.
    }
    return this.pos > start;
  }
  eatSpace() {
    const start = this.pos;
    while (/[\s ]/.test(this.string.charAt(this.pos))) this.pos += 1;
    return this.pos > start;
  }
  skipToEnd() {
    this.pos = this.string.length;
  }
  backUp(count: number) {
    this.pos -= count;
  }
  current() {
    return this.string.slice(this.start, this.pos);
  }
  match(pattern: string | RegExp, consume = true, caseInsensitive = false) {
    if (typeof pattern === "string") {
      const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
      const candidate = this.string.slice(this.pos, this.pos + pattern.length);
      if (fold(candidate) !== fold(pattern)) return undefined;
      if (consume) this.pos += pattern.length;
      return true;
    }
    const match = this.string.slice(this.pos).match(pattern);
    if (!match || match.index! > 0) return null;
    if (consume) this.pos += match[0].length;
    return match;
  }
}

interface DialogOptions {
  value?: string;
  selectValueOnOpen?: boolean;
  closeOnEnter?: boolean;
  closeOnBlur?: boolean;
  onClose?: (dialog: HTMLElement) => void;
  onInput?: (event: Event, value: string, close: (value?: string) => void) => void;
  onKeyUp?: (event: Event, value: string, close: (value?: string) => void) => void;
  onKeyDown?: (event: KeyboardEvent, value: string, close: (value?: string) => void) => boolean;
}

/** A CodeMirror-5-style view of the composer, which is the interface the engine drives. */
export interface VimFlatText {
  readonly text: string;
  readonly lineStarts: ReadonlyArray<number>;
}

/** A CodeMirror-5-style view of a text surface, which is the interface the engine drives. */
export abstract class VimEditor {
  /** Set by the patched engine while it pastes, the only time cached formatting applies. */
  pasting: false | "text" | "below" | "above" = false;
  pastingRegister: string | undefined;
  protected throughEnd = false;

  abstract get flat(): VimFlatText;
  abstract get element(): HTMLElement;
  abstract get editable(): boolean;
  protected abstract headOffset(): number;
  protected abstract attachPanel(panel: HTMLElement): void;
  protected abstract replace(start: number, end: number, text: string): void;
  protected abstract select(anchor: VimPos, head: VimPos): void;
  protected abstract moveToVisualLineEdge(end: boolean): void;
  abstract getCursor(which?: "head" | "anchor" | "start" | "end"): VimPos;
  abstract getRange(from: VimPos, to: VimPos): string;
  abstract openLine(after: boolean): void;
  abstract scrollIntoView(): void;
  abstract addOverlay(overlay: { query: RegExp }): RegExp;
  abstract removeOverlay(): void;
  abstract undoChange(): void;
  abstract redoChange(): void;

  getWrapperElement() {
    return this.element.parentElement ?? this.element;
  }
  protected onPromptClosed() {}
  /** Spaces are the default; rich surfaces override this for their own blocks. */
  indentLine(row: number, more?: boolean) {
    if (more) {
      if (this.getLine(row)) this.replaceRange(INDENT, new Pos(row, 0));
      return;
    }
    const spaces = /^ {0,2}/.exec(this.getLine(row))![0].length;
    if (spaces > 0) this.replaceRange("", new Pos(row, 0), new Pos(row, spaces));
  }
  /** Records a change for `.` and macros, the way CodeMirror batches them. */
  protected recordChange(start: number, end: number) {
    const { text } = this.flat;
    const curOp = (this.curOp ??= { $d: 0 });
    curOp.$changeStart = Math.min(curOp.$changeStart ?? start, start);
    this.lastChangeEnd = end;
    const change = { text: text.slice(start, end).split("\n") };
    if (curOp.lastChange) curOp.lastChange.next = change;
    else curOp.change = change;
    curOp.lastChange = change;
    curOp.changeHandlers ??= this._handlers.change?.slice() ?? [];
  }

  state: CM5EditorInterface["state"] = {};
  marks: CM5EditorInterface["marks"] = Object.create(null) as CM5EditorInterface["marks"];
  $mid = 0;
  curOp: CM5EditorInterface["curOp"] = null;
  options = {};
  _handlers: Record<string, Handler[]> = {};
  virtualSelection = null;
  /** Set while a c operator runs: its lines stay, emptied, for the text that follows. */
  changing = false;
  /** True while the engine moves the caret; only outside moves need clamping. */
  selecting = false;
  onDialogBlur: (() => void) | null = null;
  protected lastChangeEnd = 0;
  private panel: HTMLElement | null = null;

  on(type: string, handler: Handler) {
    on(this, type, handler);
  }
  off(type: string, handler: Handler) {
    off(this, type, handler);
  }
  signal(type: string, ...args: unknown[]) {
    signal(this, type, ...args);
  }

  indexFromPos(pos: VimPos) {
    const { lineStarts, text } = this.flat;
    if (pos.line < 0) return 0;
    if (pos.line >= lineStarts.length) return text.length;
    const start = lineStarts[pos.line]!;
    const next = lineStarts[pos.line + 1];
    const end = next === undefined ? text.length : next - 1;
    return Math.min(start + Math.max(0, pos.ch), end);
  }
  posFromIndex(offset: number) {
    const { lineStarts } = this.flat;
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return new Pos(low, offset - lineStarts[low]!);
  }

  firstLine() {
    return 0;
  }
  lastLine() {
    return this.flat.lineStarts.length - 1;
  }
  lineCount() {
    return this.flat.lineStarts.length;
  }
  getLine(row: number) {
    const { lineStarts, text } = this.flat;
    const start = lineStarts[row];
    if (start === undefined) return undefined as unknown as string;
    const next = lineStarts[row + 1];
    return text.slice(start, next === undefined ? text.length : next - 1);
  }
  clipPos(pos: VimPos) {
    const line = Math.max(0, Math.min(pos.line, this.lastLine()));
    const ch = Math.max(0, Math.min(pos.ch ?? Infinity, this.getLine(line).length));
    return new Pos(line, ch);
  }
  listSelections() {
    return [{ anchor: this.getCursor("anchor"), head: this.getCursor("head") }];
  }

  /** Engine columns are UTF-16 units; a caret must not land inside a character. */
  protected snap(offset: number, forward: boolean) {
    const segment = graphemes.segment(this.flat.text).containing(offset);
    if (!segment || segment.index === offset) return offset;
    return forward ? segment.index + segment.segment.length : segment.index;
  }
  setCursor(line: number | VimPos, ch?: number) {
    const pos = typeof line === "number" ? new Pos(line, ch ?? 0) : line;
    this.select(pos, pos);
  }
  setSelection(anchor: VimPos, head: VimPos) {
    this.select(anchor, head);
  }
  setSelections(ranges: ReadonlyArray<{ anchor: VimPos; head: VimPos }>, primary = 0) {
    const range = ranges[primary] ?? ranges[0];
    if (range) this.select(range.anchor, range.head);
  }
  getSelection() {
    return this.getRange(this.getCursor("start"), this.getCursor("end"));
  }
  getSelections() {
    return [this.getSelection()];
  }
  getValue() {
    return this.flat.text;
  }
  replaceRange(text: string, from: VimPos, to = from) {
    // Upward motions such as dk arrive reversed.
    const [start, end] = [this.indexFromPos(from), this.indexFromPos(to)].sort((a, b) => a - b);
    this.throughEnd = Math.max(from.line, to.line) > this.lastLine();
    this.replace(start!, end!, text);
    this.throughEnd = false;
  }
  replaceSelection(text: string) {
    this.replaceRange(text, this.getCursor("start"), this.getCursor("end"));
  }
  replaceSelections(replacements: ReadonlyArray<string>) {
    this.replaceSelection(replacements[0] ?? "");
  }
  /** Whether the cursor sits on the line's last character, however many code units that is. */
  onLastCharacter(cursor: VimPos) {
    const line = this.getLine(cursor.line);
    if (!line) return false;
    const index = this.indexFromPos(cursor);
    const end = this.indexFromPos(new Pos(cursor.line, line.length));
    return this.snap(index + 1, true) >= end;
  }
  removePanel() {
    this.panel?.remove();
    this.panel = null;
  }
  moveCaret(direction: 1 | -1) {
    const { text } = this.flat;
    const offset = this.headOffset();
    const next = Math.max(0, Math.min(text.length, offset + direction));
    this.setCursor(this.posFromIndex(next));
  }
  moveLine(direction: 1 | -1) {
    const cursor = this.getCursor();
    this.setCursor(this.clipPos(new Pos(cursor.line + direction, cursor.ch)));
  }
  deleteCharacter(direction: 1 | -1) {
    const offset = this.headOffset();
    if (direction > 0) this.replace(offset, Math.min(this.flat.text.length, offset + 1), "");
    else if (offset > 0) this.replace(this.snap(offset - 1, false), offset, "");
  }
  overWriteSelection(text: string) {
    const cursor = this.getCursor();
    const line = this.getLine(cursor.line);
    const end = cursor.ch < line.length ? new Pos(cursor.line, cursor.ch + 1) : cursor;
    this.replaceRange(text, cursor, end);
  }

  getInputField() {
    return this.element;
  }
  focus() {
    this.element.focus();
  }
  blur() {
    this.element.blur();
  }
  defaultTextHeight() {
    return Number.parseFloat(getComputedStyle(this.element).lineHeight) || 20;
  }
  foldCode() {}
  refresh() {}
  setSize(_width?: number | string, _height?: number | string) {}
  destroy() {}
  getMode() {
    return { name: "text" };
  }
  /** ci" reads this to pair quotes; apostrophes in prose make single quotes unreliable. */
  getTokenTypeAt(pos: VimPos) {
    const before = this.getLine(pos.line).slice(0, pos.ch);
    return (before.match(/"/g)?.length ?? 0) % 2 === 1 ? "string" : "";
  }
  hardWrap(options: { to: number }) {
    return options.to;
  }
  isInMultiSelectMode() {
    return false;
  }
  virtualSelectionMode() {
    return false;
  }
  forEachSelection(command: () => void) {
    command();
  }
  toggleOverwrite(enabled: boolean) {
    this.state.overwrite = enabled;
  }
  setOption(name: string, value: unknown) {
    if (name === "keyMap") this.state.keyMap = value as string;
    if (name === "textwidth") this.state.textwidth = value as number;
  }
  getOption(name: string): unknown {
    switch (name) {
      case "firstLineNumber":
        return 1;
      case "tabSize":
      case "indentUnit":
        return INDENT.length;
      case "indentWithTabs":
        return false;
      case "readOnly":
        return !this.editable;
      case "textwidth":
        return this.state.textwidth;
      case "keyMap":
        return this.state.keyMap ?? "vim";
      default:
        return undefined;
    }
  }

  findMatchingBracket(pos: VimPos) {
    const character = this.getLine(pos.line).charAt(pos.ch);
    const pair = BRACKET_PAIRS.find((candidate) => candidate.includes(character));
    if (!character || !pair) return { to: undefined };
    const opening = character === pair[0];
    const found = this.scanForBracket(
      new Pos(pos.line, pos.ch + (opening ? 1 : 0)),
      opening ? 1 : -1,
      undefined,
      { bracketRegex: new RegExp(`[\\${pair[0]}\\${pair[1]}]`) },
    );
    return found ? { to: found.pos } : { to: undefined };
  }
  scanForBracket(
    where: VimPos,
    direction: 1 | -1,
    _style?: unknown,
    config?: { bracketRegex?: RegExp },
  ) {
    const pattern = config?.bracketRegex ?? /[(){}[\]]/;
    const stack: string[] = [];
    const openers = "([{<";
    const last = direction > 0 ? this.lastLine() + 1 : -1;
    for (let row = where.line; row !== last; row += direction) {
      const line = this.getLine(row);
      const end = direction > 0 ? line.length : -1;
      let ch = direction > 0 ? 0 : line.length - 1;
      if (row === where.line) ch = where.ch - (direction < 0 ? 1 : 0);
      for (; ch !== end; ch += direction) {
        const character = line.charAt(ch);
        if (!pattern.test(character)) continue;
        if (openers.includes(character) === direction > 0) stack.push(character);
        else if (stack.length === 0) return { pos: new Pos(row, ch), ch: character };
        else stack.pop();
      }
    }
    return false as const;
  }
  execCommand(name: string) {
    if (name === "goLineLeft") this.moveToVisualLineEdge(false);
    else if (name === "goLineRight") this.moveToVisualLineEdge(true);
    else commands[name]?.(this);
  }

  getSearchCursor(query: RegExp, pos: VimPos) {
    const cm = this;
    const flags = `${query.flags.replace(/[gmy]/g, "")}gm`;
    const pattern = new RegExp(query.source, flags);
    const start = this.indexFromPos(pos.ch === undefined ? new Pos(pos.line, Infinity) : pos);
    let last: { from: number; to: number; match: RegExpExecArray } | null = null;
    const matchFrom = (index: number) => {
      if (index > cm.flat.text.length) return null;
      pattern.lastIndex = index;
      const match = pattern.exec(cm.flat.text);
      return match ? { from: match.index, to: match.index + match[0].length, match } : null;
    };
    const matchBefore = (limit: number) => {
      const { text } = cm.flat;
      let found: typeof last = null;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const empty = match[0].length === 0;
        // Vim searches back by where a match starts, so one may run past the limit.
        if (match.index > limit || (match.index === limit && !empty)) break;
        // An empty match right after a real one is the same search position.
        if (!empty || !found || found.to !== match.index) {
          found = { from: match.index, to: match.index + match[0].length, match };
        }
        if (empty) pattern.lastIndex += 1;
      }
      return found;
    };
    return {
      findNext() {
        return this.find(false);
      },
      findPrevious() {
        return this.find(true);
      },
      find(back?: boolean) {
        const empty = last !== null && last.from === last.to;
        if (back) last = matchBefore(last ? (empty ? last.to - 1 : last.from) : start);
        else last = matchFrom(last ? (empty ? last.to + 1 : last.to) : start);
        return last?.match ?? null;
      },
      from: () => (last ? cm.posFromIndex(last.from) : undefined),
      to: () => (last ? cm.posFromIndex(last.to) : undefined),
      replace(text: string) {
        if (!last) return;
        cm.replace(last.from, last.to, text);
        last = { ...last, to: last.from + text.length };
      },
      get match() {
        return last?.match ?? null;
      },
    };
  }

  protected bounds() {
    return this.element.getBoundingClientRect();
  }
  getScrollInfo() {
    const dom = this.element;
    return {
      left: dom.scrollLeft,
      top: dom.scrollTop,
      height: dom.scrollHeight,
      width: dom.scrollWidth,
      clientHeight: dom.clientHeight,
      clientWidth: dom.clientWidth,
    };
  }
  scrollTo(x?: number | null, y?: number | null) {
    if (x != null) this.element.scrollLeft = x;
    if (y != null) this.element.scrollTop = y;
  }

  getLastEditEnd() {
    return this.posFromIndex(this.lastChangeEnd);
  }
  onSelectionChange() {
    const curOp = (this.curOp ??= { $d: 0 });
    curOp.cursorActivityHandlers ??= this._handlers.cursorActivity?.slice() ?? [];
    curOp.cursorActivity = true;
  }
  operation<T>(run: () => T): T {
    const curOp = (this.curOp ??= { $d: 0 });
    curOp.$d += 1;
    try {
      return run();
    } finally {
      if (this.curOp) {
        this.curOp.$d -= 1;
        if (this.curOp.$d === 0) this.endOperation();
      }
    }
  }
  endOperation() {
    const op = this.curOp;
    if (!op) return;
    if (op.change) runHandlers(op.changeHandlers as Handler[], this, op.change);
    if (op.cursorActivity) runHandlers(op.cursorActivityHandlers as Handler[], this, null);
    this.curOp = null;
    if (op.isVimOp && op.cursorActivity) this.scrollIntoView();
  }

  private host() {
    if (this.panel?.isConnected) return this.panel;
    const panel = document.createElement("div");
    panel.dataset.vimPanel = "";
    panel.className =
      "font-mono text-xs text-muted-foreground [&_input]:border-0 [&_input]:bg-transparent [&_input]:shadow-none [&_input]:outline-none";
    this.attachPanel(panel);
    this.panel = panel;
    return panel;
  }
  private show(template: Node) {
    const dialog = document.createElement("div");
    dialog.append(template);
    // A message replacing the prompt must not strand focus on a removed input.
    if (this.state.dialog?.contains(document.activeElement)) this.focus();
    this.host().replaceChildren(dialog);
    this.state.dialog = dialog;
    return dialog;
  }
  get promptOpen() {
    return this.state.dialog?.querySelector("input") != null;
  }
  private hide(dialog: HTMLElement) {
    dialog.remove();
    if (this.state.dialog === dialog) this.state.dialog = null;
  }
  openNotification(template: Node, options?: { duration?: number }) {
    this.state.currentNotificationClose?.();
    const dialog = this.show(template);
    const close = () => {
      window.clearTimeout(timer);
      this.hide(dialog);
    };
    // A zero duration means the message stays until a key dismisses it.
    const duration = options?.duration ?? NOTIFICATION_DURATION;
    const timer = duration ? window.setTimeout(close, duration) : undefined;
    this.state.currentNotificationClose = close;
    return close;
  }
  openDialog(
    template: Element,
    callback: ((value: string) => void) | undefined,
    options: DialogOptions = {},
  ) {
    this.state.currentNotificationClose?.();
    this.state.currentNotificationClose = null;
    const dialog = this.show(template);
    const input = dialog.querySelector("input");
    let closed = false;
    const close = (value?: string, restoreFocus = true) => {
      if (typeof value === "string") {
        if (input) input.value = value;
        return;
      }
      if (closed) return;
      closed = true;
      this.hide(dialog);
      if (restoreFocus && !this.state.dialog) this.focus();
      options.onClose?.(dialog);
      this.onPromptClosed();
    };
    if (!input) return close;
    if (options.value) {
      input.value = options.value;
      if (options.selectValueOnOpen !== false) input.select();
    }
    if (options.onInput) {
      input.addEventListener("input", (event) => options.onInput?.(event, input.value, close));
    }
    if (options.onKeyUp) {
      input.addEventListener("keyup", (event) => options.onKeyUp?.(event, input.value, close));
    }
    input.addEventListener("keydown", (event) => {
      // The composer is a form, and its key handlers must not see this input.
      event.stopPropagation();
      if (event.key === "Enter") event.preventDefault();
      if (options.onKeyDown?.(event, input.value, close)) return;
      if (event.key === "Enter") callback?.(input.value);
      if (event.key === "Escape" || (options.closeOnEnter !== false && event.key === "Enter")) {
        input.blur();
        event.preventDefault();
        close();
      }
    });
    if (options.closeOnBlur !== false) {
      input.addEventListener("blur", () => {
        window.setTimeout(() => {
          if (closed || document.activeElement === input) return;
          // Focus went somewhere on purpose, so it must stay there.
          close(undefined, false);
          this.onDialogBlur?.();
        });
      });
    }
    input.focus();
    return close;
  }
}

/** The rich composer plugs in here without the engine depending on it. */
export const vimTextHooks = {
  rememberRegisterText: (
    _register: string | undefined,
    _operator: string,
    _text: string,
  ): void => {},
  clipboardText: (text: string): string => text,
};

const commands: Record<string, (cm: VimEditor) => void> = {
  undo: (cm) => cm.undoChange(),
  redo: (cm) => cm.redoChange(),
  newlineAndIndent: (cm) => cm.replaceSelection("\n"),
  cursorCharLeft: (cm) => {
    const cursor = cm.getCursor();
    cm.setCursor(cursor.line, cursor.ch - 1);
  },
  indentAuto: () => {},
};

/** The insert-mode keys `.` replays; arrow names reach it with and without their prefix. */
const replayKeys: Record<string, (cm: VimEditor) => void> = {
  Left: (cm) => cm.moveCaret(-1),
  Right: (cm) => cm.moveCaret(1),
  Up: (cm) => cm.moveLine(-1),
  Down: (cm) => cm.moveLine(1),
  Backspace: (cm) => cm.deleteCharacter(-1),
  Delete: (cm) => cm.deleteCharacter(1),
};

const CodeMirrorStatics = Object.assign(VimEditor, {
  Pos,
  StringStream,
  commands,
  isMac: isMacPlatform(navigator.platform),
  on,
  off,
  signal,
  e_stop(event: Event) {
    event.preventDefault();
    event.stopPropagation();
  },
  isWordChar: (character: string) => WORD_CHARACTER.test(character),
  rememberRegisterText: (register: string | undefined, operator: string, text: string) =>
    vimTextHooks.rememberRegisterText(register, operator, text),
  // navigator.clipboard is absent on plain HTTP, which is how LAN and Tailscale hosts are reached.
  writeClipboard(text: string) {
    void navigator.clipboard?.writeText(vimTextHooks.clipboardText(text)).catch(() => {});
  },
  readClipboard: () => navigator.clipboard?.readText().catch(() => "") ?? Promise.resolve(""),
  lookupKey(key: string, _map: string, handle: (binding: (cm: VimEditor) => void) => void) {
    const binding = replayKeys[key.replace(/^Arrow/, "")];
    if (binding) handle(binding);
  },
});

export const Vim = initVim(CodeMirrorStatics as unknown as Parameters<typeof initVim>[0]);

// Ctrl+V is paste off macOS, and text surfaces have one selection, so block mode stays out.
Vim.unmap("<C-v>", "normal");
Vim.unmap("<C-q>", "normal");
Vim.unmap("<C-v>", "visual");
Vim.unmap("<C-q>", "visual");

function modeFromEvent(event: { mode: string; subMode?: string }): VimMode {
  if (event.mode === "visual") return event.subMode === "linewise" ? "visual line" : "visual";
  return event.mode === "insert" || event.mode === "replace" ? event.mode : "normal";
}

interface VimControllerHooks {
  /** Whether a key event belongs to this surface rather than something nested in it. */
  readonly ownsEvent: (event: KeyboardEvent) => boolean;
  readonly setMode: (mode: VimMode) => void;
  /** Runs after each key in normal mode, once the engine has finished. */
  readonly afterKey?: () => void;
}

/** The key rules every surface shares: what the engine takes and what stays with the app. */
export function createVimController(cm: VimEditor, hooks: VimControllerHooks) {
  const editor = cm as unknown as CM5EditorInterface;
  let inKey = false;
  let returning = false;
  let session = 0;
  let sessionStarted = false;

  const nextSession = () => {
    session += 1;
    sessionStarted = false;
  };
  const vim = () => Vim.maybeInitVimState_(editor);
  const isPending = () => {
    const { inputState, visualMode } = vim();
    return (
      visualMode ||
      vim().insertModeReturn === true ||
      cm.state.closeVimNotification != null ||
      inputState.keyBuffer.length > 0 ||
      inputState.operator != null ||
      inputState.registerName != null ||
      inputState.prefixRepeat.length > 0 ||
      inputState.motionRepeat.length > 0
    );
  };
  const handleKey = (key: string) => {
    if (!vim().insertMode && !isPending()) nextSession();
    inKey = true;
    try {
      const handled = Vim.multiSelectHandleKey(editor, key, "user");
      const { insertMode, visualMode } = vim();
      // Some engine commands leave the cursor past the last character.
      if (!insertMode && !visualMode) {
        const cursor = cm.getCursor();
        const last = Math.max(0, cm.getLine(cursor.line).length - 1);
        if (cursor.ch > last) cm.setCursor(cursor.line, last);
        hooks.afterKey?.();
      }
      return handled;
    } finally {
      inKey = false;
      cm.changing = false;
    }
  };
  const clearSearch = () => {
    const search = vim().searchState_;
    if (!search?.getOverlay()) return false;
    cm.removeOverlay();
    search.setOverlay(null);
    return true;
  };
  const returnToInsert = () => {
    if (vim().insertMode && !cm.state.overwrite) return;
    handleKey("<Esc>");
    // The mode changes before the caret moves; a surface must not see insert mode at a stale
    // caret, where it could open a menu just as focus leaves.
    returning = true;
    // Normal mode rests on the last character, and text typed next belongs after it.
    handleKey(cm.onLastCharacter(cm.getCursor()) ? "a" : "i");
    returning = false;
    hooks.setMode("insert");
  };

  // cw deletes then inserts as one change, so a mode change must not start a new undo step.
  cm.on("vim-mode-change", (event: { mode: string; subMode?: string }) => {
    if (!returning) hooks.setMode(modeFromEvent(event));
  });
  cm.onDialogBlur = () => {
    if (document.activeElement !== cm.element) returnToInsert();
  };

  Vim.enterVimMode(editor);
  handleKey("i");

  return {
    vim,
    isPending,
    isInKey: () => inKey,
    handleKey,
    nextSession,
    returnToInsert,
    undoSession() {
      const isNew = !sessionStarted;
      sessionStarted = true;
      return { id: session + 1, isNew };
    },
    handleKeyDown(event: KeyboardEvent, dismissMenu: () => boolean) {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return false;
      if (!hooks.ownsEvent(event)) return false;
      const state = vim();
      // AltGr reports as Ctrl+Alt on Windows, and it types characters.
      const altGraph = event.getModifierState("AltGraph");
      const key =
        altGraph && event.key.length === 1 ? event.key : Vim.vimKeyFromEvent(event, state);
      if (!key) return false;
      const mac = isMacPlatform(navigator.platform);
      // Off macOS, Ctrl+C is copy.
      const escape = key === "<Esc>" || key === "<C-[>" || (mac && key === "<C-c>");
      const ctrl = event.ctrlKey && !altGraph;
      const chord = ctrl || event.metaKey || (event.altKey && !altGraph);

      if (state.insertMode) {
        if (escape) {
          if (dismissMenu()) return true;
          // The surface must see normal mode before the caret steps back onto a trigger.
          hooks.setMode("normal");
        } else if (chord && !(mac && MAC_INSERT_CTRL_KEYS.has(key))) {
          return false;
        } else if (key === "<C-w>" && cm.getCursor().ch === 0) {
          // At a line's start, vim takes only the line break.
          cm.deleteCharacter(-1);
          return true;
        } else if (cm.state.overwrite && key === "<CR>") {
          cm.replaceSelection("\n");
          return true;
        } else if (CARET_KEYS.test(key)) {
          // Native caret keys can reach the surface together with the next character.
          nextSession();
        }
      } else {
        if (key === "<CR>") {
          if (!isPending()) return false;
          // Mid-command, Enter belongs to vim; it must never send a half-edited prompt.
          handleKey(key);
          return true;
        }
        if (HOST_OWNED_KEYS.has(key)) return false;
        if (escape && !isPending()) return clearSearch();
        // Deleting keys must never reach native editing here, bound or not.
        if (event.key === "Backspace" || event.key === "Delete") {
          if (!chord) handleKey(key);
          return true;
        }
        if (event.metaKey) return false;
        if (ctrl && !escape && !mac && !PORTABLE_CTRL_KEYS.has(key)) return false;
      }
      const handled = Boolean(handleKey(key === "<C-[>" ? "<Esc>" : key));
      if (handled || !state.insertMode || !cm.state.overwrite) return handled;
      if (event.key === "Backspace") {
        cm.moveCaret(-1);
        return true;
      }
      if ([...event.key].length !== 1 || chord) return false;
      cm.overWriteSelection(event.key);
      return true;
    },
    onBlur() {
      if (!cm.promptOpen) returnToInsert();
    },
    destroy() {
      if (vim().insertMode) handleKey("<Esc>");
      cm.removePanel();
      Vim.leaveVimMode(editor);
    },
  };
}

import type { Pos as VimPos } from "@replit/codemirror-vim-core";

import {
  createVimController,
  graphemes,
  Pos,
  VimEditor,
  vimTextHooks,
  type VimFlatText,
  type VimMode,
} from "./vim-engine";

const MODE_LABELS: Record<Exclude<VimMode, "insert">, string> = {
  normal: "NORMAL",
  visual: "VISUAL",
  "visual line": "V-LINE",
  replace: "REPLACE",
};
const AVERAGE_CHARACTER_WIDTH = 8;

interface Snapshot {
  readonly value: string;
  readonly cursor: number;
}

/** A text position that follows edits, as bookmarks and `:g` line handles need. */
class Tracked {
  constructor(
    public offset: number | null,
    private readonly stickToStart: boolean,
  ) {}
  update(start: number, end: number, inserted: number) {
    if (this.offset === null) return;
    if (this.offset > start && this.offset < end) this.offset = null;
    else if (this.offset > end || (this.offset === end && !this.stickToStart)) {
      this.offset += inserted - (end - start);
    }
  }
}

function changedRange(before: string, after: string) {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;
  let tail = 0;
  while (
    tail < shortest - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { start, oldEnd: before.length - tail, newEnd: after.length - tail };
}

export class TextareaVimEditor extends VimEditor {
  /** Normal and visual modes keep their own cursor; the DOM selection only draws it. */
  private anchor = 0;
  private head = 0;
  private mode: VimMode = "insert";
  private cached: VimFlatText = { text: "", lineStarts: [0] };
  private readonly tracked = new Set<Tracked>();
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  private drawn: readonly [number, number] = [0, 0];
  private beforeNativeInput = "";
  private ownInput = false;
  private label: HTMLElement | null = null;
  /** Lets the host start an undo step before the first edit of a command. */
  beforeChange: (cursor: number) => void = () => {};

  constructor(readonly textarea: HTMLTextAreaElement) {
    super();
  }

  get element() {
    return this.textarea;
  }
  get editable() {
    return !this.textarea.readOnly && !this.textarea.disabled;
  }
  get flat() {
    const text = this.textarea.value;
    if (this.cached.text === text) return this.cached;
    const lineStarts = [0];
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      lineStarts.push(index + 1);
    }
    this.cached = { text, lineStarts };
    return this.cached;
  }

  /** The engine flips its flag before signalling, so only this tracks what the DOM is drawing. */
  private get insertMode() {
    return this.mode === "insert" || this.mode === "replace";
  }
  private offsets() {
    const { selectionStart, selectionEnd, selectionDirection, value } = this.textarea;
    if (!this.insertMode) {
      const clamp = (offset: number) => Math.min(offset, value.length);
      return { anchor: clamp(this.anchor), head: clamp(this.head) };
    }
    return selectionDirection === "backward"
      ? { anchor: selectionEnd, head: selectionStart }
      : { anchor: selectionStart, head: selectionEnd };
  }
  protected headOffset() {
    return this.offsets().head;
  }
  getCursor(which: "head" | "anchor" | "start" | "end" = "head") {
    const { anchor, head } = this.offsets();
    const offset =
      which === "anchor"
        ? anchor
        : which === "start"
          ? Math.min(anchor, head)
          : which === "end"
            ? Math.max(anchor, head)
            : head;
    return this.posFromIndex(offset);
  }
  somethingSelected() {
    const { anchor, head } = this.offsets();
    return anchor !== head;
  }
  protected select(anchor: VimPos, head: VimPos) {
    const current = this.headOffset();
    const anchorOffset = this.indexFromPos(anchor);
    const headOffset = this.indexFromPos(head);
    this.anchor = this.snap(anchorOffset, anchorOffset >= current);
    this.head = this.snap(headOffset, headOffset >= current);
    this.draw();
    // The engine learns of selections from outside a command this way, as it would in an editor.
    this.onSelectionChange();
    if (this.curOp && !this.curOp.isVimOp && this.curOp.$d === 0) this.endOperation();
  }
  /** Normal mode draws the cursor as a one-character selection, a textarea's only highlight. */
  private draw() {
    const { text } = this.flat;
    let start = Math.min(this.anchor, this.head);
    let end = Math.max(this.anchor, this.head);
    if (this.mode === "normal" && this.head < text.length && text[this.head] !== "\n") {
      const segment = graphemes.segment(text).containing(this.head);
      start = this.head;
      end = segment ? segment.index + segment.segment.length : this.head + 1;
    }
    this.drawn = [start, end];
    this.textarea.setSelectionRange(start, end, this.head < this.anchor ? "backward" : "forward");
  }
  setMode(mode: VimMode) {
    const { anchor, head } = this.offsets();
    this.mode = mode;
    this.anchor = anchor;
    this.head = head;
    this.draw();
    this.drawLabel();
  }
  private drawLabel() {
    if (this.mode === "insert") {
      this.label?.remove();
      this.label = null;
      return;
    }
    this.label ??= document.createElement("div");
    const label = this.label;
    label.setAttribute("role", "status");
    label.dataset.vimModeLabel = "";
    label.className =
      "pointer-events-none fixed z-50 bg-background px-1 font-mono text-3xs text-muted-foreground";
    label.textContent = MODE_LABELS[this.mode];
    const bounds = this.textarea.getBoundingClientRect();
    label.style.right = `${window.innerWidth - bounds.right + 2}px`;
    label.style.bottom = `${window.innerHeight - bounds.bottom + 2}px`;
    if (!label.isConnected) document.body.append(label);
  }

  /** Mouse and native caret moves arrive here; the engine's own draws are recognised. */
  onDomSelectionChange() {
    if (this.insertMode || document.activeElement !== this.textarea) return;
    const { selectionStart, selectionEnd } = this.textarea;
    if (selectionStart === this.drawn[0] && selectionEnd === this.drawn[1]) return;
    this.anchor = selectionStart;
    this.head = selectionEnd;
    this.onSelectionChange();
    this.endOperation();
    if (selectionStart === selectionEnd) {
      const cursor = this.getCursor();
      const last = Math.max(0, this.getLine(cursor.line).length - 1);
      this.setCursor(cursor.line, Math.min(cursor.ch, last));
    }
  }

  getRange(from: VimPos, to: VimPos) {
    const { text } = this.flat;
    const start = this.indexFromPos(from);
    return text.slice(start, this.snap(this.indexFromPos(to), true));
  }
  getValueForTest() {
    return this.textarea.value;
  }
  setValue(text: string) {
    this.textarea.value = text;
    this.anchor = 0;
    this.head = 0;
    this.draw();
  }

  /** React tracks a textarea through input events, so edits must announce themselves. */
  private announce() {
    this.ownInput = true;
    this.textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
    );
    this.ownInput = false;
  }
  private track(start: number, end: number, inserted: number) {
    for (const position of this.tracked) position.update(start, end, inserted);
  }
  protected replace(rangeStart: number, endOffset: number, text: string) {
    const { text: value } = this.flat;
    const to = this.snap(endOffset, true);
    let start = rangeStart === endOffset ? to : rangeStart;
    // Linewise visual change selects the line break too, which must stay for the new text.
    const trims = this.changing && !text && to > start && value[to - 1] === "\n";
    const end = trims ? to - 1 : to;
    // Removing lines through the end also removes the break before them, as no line follows.
    const multiline = value.slice(start, end).includes("\n");
    const toLastLine = end === value.length && (this.throughEnd || multiline);
    // dd on the last line arrives already holding that break; only dG's range runs past the end.
    const holdsBreak = !this.throughEnd && value[start] === "\n";
    if (!text && !this.changing && toLastLine && start > 0 && value[start - 1] === "\n") {
      if (value[end - 1] !== "\n" && !holdsBreak) start -= 1;
    }
    // Chips from the composer arrive as the prompt text they stand for.
    const plain = vimTextHooks.clipboardText(text);
    this.beforeChange(start);
    const { anchor, head } = this.offsets();
    this.textarea.setRangeText(plain, start, end, "end");
    this.track(start, end, plain.length);
    // Typing leaves the caret after the edit; a command leaves it where the engine sets it next.
    const typing = this.insertMode;
    const follow = (offset: number) => {
      if (offset > end || (offset === end && !typing)) {
        return offset + plain.length - (end - start);
      }
      return typing && offset >= start ? start + plain.length : Math.min(offset, start);
    };
    this.anchor = follow(anchor);
    this.head = follow(head);
    this.recordChange(start, start + plain.length);
    this.announce();
    this.draw();
  }
  openLine(after: boolean) {
    const cursor = this.getCursor();
    const line = this.getLine(cursor.line);
    const at = this.indexFromPos(new Pos(cursor.line, after ? line.length : 0));
    this.replace(at, at, "\n");
    this.setCursor(this.posFromIndex(after ? at + 1 : at));
  }

  snapshot(cursor = this.headOffset()): Snapshot {
    return { value: this.textarea.value, cursor };
  }
  /** Vim's undo returns to where the change began, not to where its command started. */
  pushUndo(cursor: number) {
    this.undoStack.push(this.snapshot(cursor));
    this.redoStack.length = 0;
  }
  private restore(from: Snapshot[], to: Snapshot[]) {
    const entry = from.pop();
    if (!entry) return;
    to.push(this.snapshot());
    const { value } = this.textarea;
    const { start, oldEnd, newEnd } = changedRange(value, entry.value);
    this.textarea.setRangeText(entry.value.slice(start, newEnd), start, oldEnd, "end");
    this.track(start, oldEnd, newEnd - start);
    this.announce();
    // The snapshot knows where the change began; comparing text cannot tell with repeated lines.
    this.setCursor(this.posFromIndex(entry.cursor));
  }
  undoChange() {
    this.restore(this.undoStack, this.redoStack);
  }
  redoChange() {
    this.restore(this.redoStack, this.undoStack);
  }

  onBeforeNativeInput() {
    this.beforeNativeInput = this.textarea.value;
    this.beforeChange(this.headOffset());
  }
  /** Typing bypasses the engine, but `.` still has to learn what was typed. */
  onNativeInput() {
    if (this.ownInput) return;
    const { start, oldEnd, newEnd } = changedRange(this.beforeNativeInput, this.textarea.value);
    this.track(start, oldEnd, newEnd - start);
    this.recordChange(start, newEnd);
    this.onSelectionChange();
    this.endOperation();
  }
  pasteAtCursor(text: string) {
    const head = this.headOffset();
    this.replace(head, head, text);
    this.setCursor(this.posFromIndex(Math.max(head, this.headOffset() - 1)));
  }

  getLineHandle(row: number) {
    const handle = new Tracked(this.indexFromPos(new Pos(row, 0)), false);
    this.tracked.add(handle);
    return handle;
  }
  getLineNumber(handle: Tracked) {
    if (handle.offset === null) return null;
    const pos = this.posFromIndex(handle.offset);
    return pos.ch === 0 ? pos.line : null;
  }
  releaseLineHandles() {
    this.tracked.clear();
  }
  setBookmark(cursor: VimPos, options?: { insertLeft: boolean }) {
    const position = new Tracked(this.indexFromPos(cursor), options?.insertLeft === true);
    this.tracked.add(position);
    return {
      clear: () => this.tracked.delete(position),
      find: () => (position.offset === null ? null : this.posFromIndex(position.offset)),
    };
  }

  // A textarea cannot highlight matches or report line geometry, so these work by logical line.
  addOverlay({ query }: { query: RegExp }) {
    return query;
  }
  removeOverlay() {}
  protected moveToVisualLineEdge(end: boolean) {
    const cursor = this.getCursor();
    this.setCursor(cursor.line, end ? Math.max(0, this.getLine(cursor.line).length - 1) : 0);
  }
  findPosV(start: VimPos, amount: number, unit: "page" | "line") {
    const rows =
      unit === "page"
        ? Math.max(1, Math.floor(this.textarea.clientHeight / this.defaultTextHeight()))
        : 1;
    return this.clipPos(new Pos(start.line + amount * rows, start.ch));
  }
  charCoords(pos: VimPos) {
    const height = this.defaultTextHeight();
    return {
      left: pos.ch * AVERAGE_CHARACTER_WIDTH,
      top: pos.line * height,
      bottom: (pos.line + 1) * height,
    };
  }
  coordsChar(coords: { left: number; top: number }) {
    const line = Math.floor(coords.top / this.defaultTextHeight());
    return this.clipPos(new Pos(line, Math.round(coords.left / AVERAGE_CHARACTER_WIDTH)));
  }
  scrollIntoView() {
    const height = this.defaultTextHeight();
    const top = this.getCursor().line * height;
    const { clientHeight, scrollTop } = this.textarea;
    if (top < scrollTop) this.textarea.scrollTop = top;
    else if (top + height > scrollTop + clientHeight) {
      this.textarea.scrollTop = top + height - clientHeight;
    }
  }

  protected attachPanel(panel: HTMLElement) {
    this.textarea.after(panel);
  }
  /** Commands from a prompt skip the key path, which is what normally keeps this true. */
  protected override onPromptClosed() {
    if (this.insertMode) return;
    const cursor = this.getCursor();
    const last = Math.max(0, this.getLine(cursor.line).length - 1);
    if (cursor.ch > last) this.setCursor(cursor.line, last);
  }
  removeLabel() {
    this.label?.remove();
    this.label = null;
  }
}

export function createTextareaVimHost(textarea: HTMLTextAreaElement) {
  const cm = new TextareaVimEditor(textarea);
  const controller = createVimController(cm, {
    ownsEvent: (event) => event.target === textarea,
    setMode: (mode) => cm.setMode(mode),
  });
  cm.beforeChange = (cursor) => {
    if (controller.undoSession().isNew) cm.pushUndo(cursor);
  };
  const inInsert = () => controller.vim().insertMode;
  let lastValue = textarea.value;

  const onBeforeInput = (event: InputEvent) => {
    if (inInsert()) {
      cm.onBeforeNativeInput();
      return;
    }
    // Native edits would replace the selection that draws the cursor.
    event.preventDefault();
    if (event.inputType === "insertFromPaste" && event.data) {
      controller.nextSession();
      cm.pasteAtCursor(event.data);
    }
  };
  const onInput = () => cm.onNativeInput();
  const onBlur = () => {
    // Window blur keeps activeElement; only focus really leaving counts.
    if (document.activeElement !== textarea) controller.onBlur();
  };
  const onSelectionChange = () => cm.onDomSelectionChange();
  textarea.addEventListener("beforeinput", onBeforeInput);
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("blur", onBlur);
  document.addEventListener("selectionchange", onSelectionChange);

  return {
    editor: cm,
    sendKey: controller.handleKey,
    handleKeyDown(event: KeyboardEvent) {
      // A form that clears its textarea, as a sent comment does, starts ready to type.
      if (!textarea.value && lastValue && !inInsert()) controller.returnToInsert();
      // Setting a value drops native undo history, so one history serves both.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        if (controller.vim().visualMode) controller.handleKey("<Esc>");
        if (inInsert()) {
          // Insert mode has no undo key: u is text and <C-r> reads a register.
          if (event.shiftKey) cm.redoChange();
          else cm.undoChange();
          controller.nextSession();
        } else {
          controller.handleKey(event.shiftKey ? "<C-r>" : "u");
        }
        return true;
      }
      const handled = controller.handleKeyDown(event, () => false);
      lastValue = textarea.value;
      // Handlers still see Enter, as Mod+Enter submits need, but it must not edit.
      if (!handled && event.key === "Enter" && !inInsert()) event.preventDefault();
      return handled;
    },
    destroy() {
      textarea.removeEventListener("beforeinput", onBeforeInput);
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("blur", onBlur);
      document.removeEventListener("selectionchange", onSelectionChange);
      controller.destroy();
      cm.removeLabel();
    },
  };
}

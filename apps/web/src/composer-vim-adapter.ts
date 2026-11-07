import type { Pos as VimPos } from "@replit/codemirror-vim-core";
import { redo, undo } from "@tiptap/pm/history";
import {
  Fragment,
  type Mark,
  type Node as ProseMirrorNode,
  type NodeType,
  type ResolvedPos,
  type Schema,
} from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Mapping } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

import {
  COMPOSER_VIM_ATOM_PATTERN,
  composerVimAtomJson,
  composerVimFlatOffset,
  flattenComposerVimDocument,
  setComposerVimState,
  type ComposerVimFlatDocument,
  type ComposerVimHost,
} from "./composer-vim-editor";
import { collapseShownMarkdownSource } from "~/composer-markdown-source";
import {
  alignListItemWithSiblings,
  serializeEditorDoc,
  splitOrLiftListItem,
} from "~/composer-rich-text-doc";
import { createVimController, INDENT, Pos, Vim, VimEditor, vimTextHooks } from "./vim-engine";

const LIST_ITEM_NODES = new Set(["listItem", "taskItem"]);
const UNNAMED_REGISTER = '"';
const VISUAL_LINE_PROBES = 6;

interface RichLine {
  readonly inline: ReadonlyArray<unknown> | null;
  /** The line's own block and ancestors, so a pasted line keeps being a heading or list item. */
  readonly block: unknown;
}

type RichLines = ReadonlyArray<RichLine | null>;

// Registers hold text, so each keeps its lines, in order, beside it. Identical lines inside one
// register stay distinct. What the engine reads waits here until a register takes it.
const pendingRichText = new Map<string, RichLines>();
const richRegisters = new Map<string, { readonly body: string; readonly lines: RichLines }>();

function withoutFinalNewline(text: string) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Follows the engine's own routing: yanks to 0, small deletes to -, and others down 1 to 9. */
function automaticRegister(operator: string, text: string) {
  if (operator === "yank") return "0";
  if (!text.includes("\n")) return "-";
  for (let index = 9; index >= 2; index -= 1) {
    const previous = richRegisters.get(`${index - 1}`);
    if (previous) richRegisters.set(`${index}`, previous);
    else richRegisters.delete(`${index}`);
  }
  return "1";
}

function rememberRegisterText(register: string | undefined, operator: string, text: string) {
  const body = withoutFinalNewline(text);
  const lines = pendingRichText.get(body);
  pendingRichText.clear();
  // The unnamed register always mirrors the last write.
  for (const name of [register || automaticRegister(operator, text), UNNAMED_REGISTER]) {
    if (lines?.some(Boolean)) richRegisters.set(name, { body, lines });
    else richRegisters.delete(name);
  }
}

/** A count pastes the register's text repeatedly, which only the lines can reveal. */
function richLinesFor(register: string | undefined, text: string): RichLines | null {
  const record = richRegisters.get(register ?? UNNAMED_REGISTER);
  if (!record) return null;
  if (record.body === text) return record.lines;
  const copies = (text.length + 1) / (record.body.length + 1);
  if (!Number.isInteger(copies) || copies < 2) return null;
  if (Array.from({ length: copies }, () => record.body).join("\n") !== text) return null;
  return Array.from({ length: copies }, () => record.lines).flat();
}

/** Rebuilds just this line inside copies of its ancestors. */
function lineBlock($line: ResolvedPos, inline: Fragment) {
  if ($line.depth === 1 && $line.parent.type.name === "paragraph") return null;
  let block = $line.parent.copy(inline);
  for (let depth = $line.depth - 1; depth >= 1; depth -= 1) {
    block = $line.node(depth).copy(Fragment.from(block));
    // A nested item stands alone in its own list; its parents hold other lines.
    if (LIST_ITEM_NODES.has($line.node(depth + 1).type.name)) break;
  }
  return block.toJSON() as unknown;
}

function stripAtoms(text: string) {
  return text.replace(new RegExp(COMPOSER_VIM_ATOM_PATTERN, "gu"), "");
}

function lineFragment(
  state: EditorState,
  line: string,
  marks: ReadonlyArray<Mark>,
  rich: RichLine | null | undefined,
) {
  const { schema } = state;
  try {
    if (rich?.inline) return Fragment.fromJSON(schema, rich.inline);
    if (!COMPOSER_VIM_ATOM_PATTERN.test(line)) return null;
    const nodes: ProseMirrorNode[] = [];
    let text = "";
    const flush = () => {
      if (text) nodes.push(schema.text(text, marks));
      text = "";
    };
    for (const character of line) {
      const json = composerVimAtomJson(character);
      if (json) {
        flush();
        nodes.push(schema.nodeFromJSON(json));
      } else {
        text += character;
      }
    }
    flush();
    return Fragment.from(nodes);
  } catch {
    // The plain composer's schema has no marks, and a chip may not exist on this editor.
    return null;
  }
}

/** Breaks a line the way Enter would: a newline in code, a new item in a list. */
function splitLine(tr: Transaction, at: number) {
  const $at = tr.doc.resolve(at);
  if ($at.parent.type.spec.code === true) {
    tr.insertText("\n", at);
    return;
  }
  const item = $at.depth > 1 ? $at.node(-1) : null;
  if (item && LIST_ITEM_NODES.has(item.type.name)) {
    const checked = item.type.name === "taskItem" ? { checked: false } : {};
    tr.split(at, 2, [{ type: item.type, attrs: { ...item.attrs, ...checked } }, null]);
    return;
  }
  const paragraph = tr.doc.type.schema.nodes.paragraph!;
  const atEnd = $at.parentOffset === $at.parent.content.size;
  tr.split(at, 1, atEnd && $at.parent.type.name === "heading" ? [{ type: paragraph }] : undefined);
}

function insertLines(
  state: EditorState,
  tr: Transaction,
  start: number,
  text: string,
  records?: RichLines | null,
) {
  let at = start;
  text.split("\n").forEach((line, index) => {
    if (index > 0) {
      const steps = tr.mapping.maps.length;
      splitLine(tr, at);
      at = tr.mapping.slice(steps).map(at);
    }
    if (line.length === 0) return;
    const inCode = tr.doc.resolve(at).parent.type.spec.code === true;
    const marks = tr.doc.resolve(at).marks();
    const fragment = inCode ? null : lineFragment(state, line, marks, records?.[index]);
    if (fragment) {
      tr.insert(at, fragment);
      at += fragment.size;
    } else {
      // Code cannot hold a chip, so it arrives as the text it stands for.
      const plain = inCode ? clipboardText(line) : stripAtoms(line);
      if (plain) tr.insertText(plain, at);
      at += plain.length;
    }
  });
}

function lineNode(state: EditorState, line: string, rich: RichLine | null | undefined) {
  const { schema } = state;
  if (rich?.block) return schema.nodeFromJSON(rich.block);
  const plain = stripAtoms(line);
  const content = lineFragment(state, line, [], rich) ?? (plain ? schema.text(plain) : null);
  return schema.nodes.paragraph!.create(null, content);
}

/** Neighboring lines of one list, quote, or code block arrive as that one block. */
function mergeLineNodes(nodes: ReadonlyArray<ProseMirrorNode>) {
  const merged: ProseMirrorNode[] = [];
  for (const node of nodes) {
    const previous = merged.at(-1);
    const joins = node.type.spec.code
      ? previous?.sameMarkup(node)
      : previous?.type === node.type && node.type.spec.content?.includes("+");
    if (!previous || !joins) {
      merged.push(node);
      continue;
    }
    const content = node.type.spec.code
      ? Fragment.from(node.type.schema.text(`${previous.textContent}\n${node.textContent}`))
      : previous.content.append(node.content);
    merged[merged.length - 1] = previous.copy(content);
  }
  return merged;
}

/**
 * Finds the block gap on one side of a line, climbing until `stop` is the parent or the document
 * is. Only containers between lines split: a list item keeps its nested lists.
 */
function lineGap(tr: Transaction, at: number, before: boolean, stop: NodeType | null) {
  const $at = tr.doc.resolve(at);
  let position: number;
  if (before ? $at.parentOffset > 0 : $at.parentOffset < $at.parent.content.size) {
    // A line inside a multi-line block: its newline becomes the block boundary.
    const split = before ? at - 1 : at;
    tr.delete(split, split + 1);
    tr.split(split);
    position = split + 1;
  } else {
    position = before ? $at.before() : $at.after();
  }
  for (;;) {
    const $gap = tr.doc.resolve(position);
    if ($gap.depth === 0 || $gap.parent.type === stop) return position;
    if (position === $gap.end() || LIST_ITEM_NODES.has($gap.parent.type.name)) {
      position = before && position !== $gap.end() ? $gap.before() : $gap.after();
    } else if (position === $gap.start()) {
      position = $gap.before();
    } else {
      tr.split(position);
      position += 1;
    }
  }
}

/** Lines that are headings, items, quotes, or code stay so, whatever the cursor is on. */
function pasteBlockLines(
  state: EditorState,
  tr: Transaction,
  at: number,
  text: string,
  records: RichLines,
  before: boolean,
) {
  try {
    const nodes = mergeLineNodes(
      text.split("\n").map((line, index) => lineNode(state, line, records[index])),
    );
    const only = nodes.length === 1 ? nodes[0]! : null;
    const $at = tr.doc.resolve(at);
    // Code pasted into its own kind of block is just more lines of it.
    if (only?.type === $at.parent.type && only.type.spec.code) return false;
    let stop: NodeType | null = null;
    for (let depth = $at.depth - 1; depth > 0 && !stop; depth -= 1) {
      if ($at.node(depth).type === only?.type) stop = only.type;
    }
    const gap = lineGap(tr, at, before, stop);
    tr.insert(gap, stop ? only!.content : Fragment.from(nodes));
    return true;
  } catch {
    // A block from the rich composer may not exist in the plain one.
    return false;
  }
}

class Marker {
  readonly id: number;
  constructor(
    private readonly cm: ComposerVimEditor,
    private position: number | null,
    private readonly assoc: number,
  ) {
    this.id = cm.$mid++;
    cm.marks[this.id] = this as never;
  }
  clear() {
    delete this.cm.marks[this.id];
  }
  find() {
    return this.position === null ? null : this.cm.posFromPosition(this.position);
  }
  update(mapping: Mapping) {
    if (this.position === null) return;
    const result = mapping.mapResult(this.position, this.assoc);
    this.position = result.deletedAcross ? null : result.pos;
  }
}

export class ComposerVimEditor extends VimEditor {
  cm6: EditorView;

  constructor(readonly view: EditorView) {
    super();
    this.cm6 = view;
  }

  get element() {
    return this.view.dom as HTMLElement;
  }
  get editable() {
    return this.view.editable;
  }
  protected headOffset() {
    return composerVimFlatOffset(this.flat, this.view.state.selection.head);
  }
  protected attachPanel(panel: HTMLElement) {
    this.getWrapperElement().append(panel);
  }
  undoChange() {
    runHistory(this, undo);
  }
  redoChange() {
    runHistory(this, redo);
  }
  private readonly lineHandles = new Set<{ position: number | null }>();

  get flat(): ComposerVimFlatDocument {
    return flattenComposerVimDocument(this.view.state.doc);
  }
  posFromPosition(position: number) {
    return this.posFromIndex(composerVimFlatOffset(this.flat, position));
  }
  private position(pos: VimPos) {
    return this.flat.positions[this.indexFromPos(pos)]!;
  }
  getLineHandle(row: number) {
    const handle = { row, position: this.position(new Pos(row, 0)) as number | null };
    this.lineHandles.add(handle);
    return handle;
  }
  getLineNumber(handle: { position: number | null }) {
    if (handle.position === null) return null;
    const pos = this.posFromPosition(handle.position);
    return pos.ch === 0 ? pos.line : null;
  }
  releaseLineHandles() {
    this.lineHandles.clear();
  }

  getCursor(which: "head" | "anchor" | "start" | "end" = "head") {
    const { selection } = this.view.state;
    const position =
      which === "anchor"
        ? selection.anchor
        : which === "start"
          ? selection.from
          : which === "end"
            ? selection.to
            : selection.head;
    return this.posFromPosition(position);
  }
  somethingSelected() {
    return !this.view.state.selection.empty;
  }
  protected select(anchor: VimPos, head: VimPos) {
    const current = composerVimFlatOffset(this.flat, this.view.state.selection.head);
    const headOffset = this.indexFromPos(head);
    const anchorOffset = this.indexFromPos(anchor);
    const { positions } = this.flat;
    const { state } = this.view;
    const selection = TextSelection.create(
      state.doc,
      positions[this.snap(anchorOffset, anchorOffset >= current)]!,
      positions[this.snap(headOffset, headOffset >= current)]!,
    );
    if (selection.eq(state.selection)) return;
    this.selecting = true;
    this.view.dispatch(state.tr.setSelection(selection));
    this.selecting = false;
  }

  getRange(from: VimPos, to: VimPos) {
    const { positions, text } = this.flat;
    const start = this.indexFromPos(from);
    // A register must hold everything the same range would delete.
    const end = this.snap(this.indexFromPos(to), true);
    let lineStart = start;
    const lines: Array<RichLine | null> = [];
    for (const line of text.slice(start, end).split("\n")) {
      const lineEnd = lineStart + line.length;
      const whole =
        (lineStart === 0 || text[lineStart - 1] === "\n") &&
        (lineEnd === text.length || text[lineEnd] === "\n");
      const { doc } = this.view.state;
      const inline = doc.slice(positions[lineStart]!, positions[lineEnd]!).content;
      const nodes: ProseMirrorNode[] = [];
      inline.forEach((node) => nodes.push(node));
      const marked = nodes.some((node) => node.marks.length > 0);
      const block = whole ? lineBlock(doc.resolve(positions[lineStart]!), inline) : null;
      lines.push(
        marked || block
          ? { inline: marked ? nodes.map((node) => node.toJSON() as unknown) : null, block }
          : null,
      );
      lineStart = lineEnd + 1;
    }
    const read = text.slice(start, end);
    const key = withoutFinalNewline(read);
    pendingRichText.set(key, read === key ? lines : lines.slice(0, -1));
    return text.slice(start, end);
  }
  setValue(text: string) {
    const { state } = this.view;
    const { tr } = state;
    tr.delete(0, state.doc.content.size);
    insertLines(state, tr, tr.selection.from, text);
    this.view.dispatch(tr.setSelection(TextSelection.atStart(tr.doc)));
  }

  protected replace(rangeStart: number, endOffset: number, text: string) {
    const { state } = this.view;
    const { positions } = this.flat;
    // Deleting up to a split character must take the whole of it.
    const to = this.snap(endOffset, true);
    // An insert inside a character goes after it.
    const startOffset = rangeStart === endOffset ? to : rangeStart;
    const tr = state.tr;
    if (!text && this.deleteWholeLines(tr, startOffset, to)) {
      this.view.dispatch(tr);
      return;
    }
    // Linewise visual change selects the line break too, which must stay for the new text.
    const trims = this.changing && !text && to > startOffset && this.flat.text[to - 1] === "\n";
    const kept = trims ? to - 1 : to;
    if (startOffset !== kept) tr.delete(positions[startOffset]!, positions[kept]!);
    if (text) this.insert(tr, tr.mapping.map(positions[startOffset]!), text);
    if (tr.docChanged) this.view.dispatch(tr);
  }
  private insert(tr: Transaction, at: number, text: string) {
    const { state } = this.view;
    if (!this.pasting) {
      insertLines(state, tr, at, text);
      return;
    }
    // The engine wraps a linewise register's text in one newline, which is not one of its lines.
    const body =
      this.pasting === "below"
        ? text.slice(1)
        : this.pasting === "above"
          ? text.slice(0, -1)
          : text;
    const records = richLinesFor(this.pastingRegister, body);
    // A plain line must not become a heading by being pasted against one.
    const onHeading = tr.doc.resolve(at).parent.type.name === "heading";
    const blocks = this.pasting !== "text" && (onHeading || records?.some((line) => line?.block));
    if (blocks && pasteBlockLines(state, tr, at, body, records ?? [], this.pasting === "above")) {
      return;
    }
    const leading = this.pasting === "below" ? [null] : [];
    insertLines(state, tr, at, text, records && [...leading, ...records]);
  }
  /** Removing lines must remove their blocks; a plain delete would join what follows into them. */
  private deleteWholeLines(tr: Transaction, start: number, end: number) {
    const { positions, text } = this.flat;
    if (end <= start || this.changing) return false;
    const atLineStart = start === 0 || text[start - 1] === "\n";
    const multiline = text.slice(start, end).includes("\n");
    let first: number;
    let last: number;
    // dG from a blank line and dd on the line after it share these offsets. The patched engine
    // ends only dG's range past the last line.
    if (
      atLineStart &&
      end === text.length &&
      (this.throughEnd || (multiline && text[end - 1] !== "\n"))
    ) {
      [first, last] = this.throughEnd || text[start] !== "\n" ? [start, end] : [start + 1, end];
    } else if (atLineStart && text[end - 1] === "\n") [first, last] = [start, end - 1];
    else if (text[start] === "\n" && (end === text.length || text[end] === "\n")) {
      [first, last] = [start + 1, end];
    } else return false;

    const $first = tr.doc.resolve(positions[first]!);
    const $last = tr.doc.resolve(positions[last]!);
    const headCovered = $first.parentOffset === 0;
    const tailCovered = $last.parentOffset === $last.parent.content.size;
    // A line that is all of its item goes with the item, or the bullet would stay behind.
    const blockDepth = ($line: ResolvedPos) =>
      $line.depth > 1 &&
      LIST_ITEM_NODES.has($line.node(-1).type.name) &&
      $line.node(-1).childCount === 1
        ? $line.depth - 1
        : $line.depth;
    if ($first.sameParent($last)) {
      if (headCovered && tailCovered) {
        tr.deleteRange($first.before(blockDepth($first)), $last.after(blockDepth($last)));
      } else if (tailCovered) tr.delete(positions[first - 1]!, positions[last]!);
      else tr.delete(positions[first]!, positions[last + 1]!);
      return true;
    }
    // Later edits first, so earlier positions stay valid. Each covered block goes on its own, so a
    // range leaving a list still takes the whole last item.
    if (!tailCovered) tr.delete($last.start(), positions[last + 1]!);
    const from = headCovered ? positions[first]! : $first.after();
    const to = tailCovered ? positions[last]! : $last.before();
    const covered: number[] = [];
    tr.doc.nodesBetween(from, Math.max(from, to), (node, position) => {
      if (node.isTextblock) covered.push(position + 1);
      return !node.isTextblock;
    });
    for (const position of covered.reverse()) {
      const $block = tr.doc.resolve(position);
      tr.deleteRange($block.before(blockDepth($block)), $block.after(blockDepth($block)));
    }
    if (!headCovered) tr.delete(positions[first - 1]!, $first.end());
    return true;
  }
  /** o and O, called from the patched engine: each opens a line in the block it belongs to. */
  openLine(after: boolean) {
    const cursor = this.getCursor();
    const line = this.getLine(cursor.line);
    this.setCursor(cursor.line, after ? line.length : 0);
    if (after) {
      const { $from } = this.view.state.selection;
      const inItem = $from.depth > 1 && LIST_ITEM_NODES.has($from.node(-1).type.name);
      const atEnd = $from.parentOffset === $from.parent.content.size;
      const editor = this.richEditor();
      if (inItem && atEnd && line && splitOrLiftListItem(editor, collapseShownMarkdownSource)) {
        return;
      }
      this.replaceSelection("\n");
      return;
    }
    const { state } = this.view;
    const { $from } = state.selection;
    if ($from.parentOffset > 0 || $from.parent.type.spec.code === true) {
      this.replaceSelection("\n");
      this.setCursor(cursor.line, 0);
      return;
    }
    const item = $from.depth > 1 ? $from.node(-1) : null;
    const paragraph = state.schema.nodes.paragraph!.create();
    const { tr } = state;
    if (item && LIST_ITEM_NODES.has(item.type.name)) {
      const checked = item.type.name === "taskItem" ? { checked: false } : {};
      const at = $from.before(-1);
      tr.insert(at, item.type.create({ ...item.attrs, ...checked }, paragraph));
      tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
      alignListItemWithSiblings(tr, item.type.name);
    } else {
      const at = $from.before();
      tr.insert(at, paragraph);
      tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
    }
    this.view.dispatch(tr);
  }

  override indentLine(row: number, more?: boolean) {
    const $line = this.view.state.doc.resolve(this.position(new Pos(row, 0)));
    const item = $line.depth > 1 ? $line.node(-1).type.name : "";
    if (LIST_ITEM_NODES.has(item)) {
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near($line)));
      this.indentListItem(item, more === true);
      return;
    }
    super.indentLine(row, more);
  }
  /** The prompt text comes from the item's indent attribute, not its nesting. */
  private indentListItem(name: string, more: boolean) {
    const $from = this.view.state.selection.$from;
    const indent = String($from.node(-1).attrs.indent ?? "");
    if (!more && !indent) return;
    const { commands } = this.richEditor();
    const nested = $from.depth >= 5 && LIST_ITEM_NODES.has($from.node(-3).type.name);
    if (!(more ? commands.sinkListItem(name) : !nested || commands.liftListItem(name))) return;
    const $item = this.view.state.selection.$from;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup($item.before(-1), undefined, {
        ...$item.node(-1).attrs,
        indent: more ? indent + INDENT : indent.slice(INDENT.length),
      }),
    );
  }
  richEditor() {
    return (this.view.dom as HTMLElement & { editor: RichEditor }).editor;
  }

  /** g0 and g$ stop at the wrap, not the line break. */
  protected moveToVisualLineEdge(end: boolean) {
    const bounds = this.bounds();
    const coords = this.view.coordsAtPos(this.view.state.selection.head);
    const found = this.view.posAtCoords({
      left: end ? bounds.right - 1 : bounds.left + 1,
      top: (coords.top + coords.bottom) / 2,
    });
    if (!found) return;
    const pos = this.posFromPosition(found.pos);
    // The far edge reads as the gap after the last character, which is the next line's start.
    this.setCursor(pos.line, end ? Math.max(0, pos.ch - 1) : pos.ch);
  }

  setBookmark(cursor: VimPos, options?: { insertLeft: boolean }) {
    return new Marker(this, this.position(cursor), options?.insertLeft ? 1 : -1);
  }

  addOverlay({ query }: { query: RegExp }) {
    this.view.dispatch(setComposerVimState(this.view.state.tr, { search: query }));
    return query;
  }
  removeOverlay() {
    this.view.dispatch(setComposerVimState(this.view.state.tr, { search: null }));
  }
  findPosV(start: VimPos, amount: number, unit: "page" | "line", goalColumn?: number) {
    const height = this.defaultTextHeight();
    if (unit === "page") {
      const page = Math.max(1, Math.floor(this.view.dom.clientHeight / height));
      return this.clipPos(new Pos(start.line + amount * page, start.ch));
    }
    const dom = this.view.dom;
    let current = start;
    for (let round = 0; round < Math.abs(amount); round += 1) {
      const direction = amount > 0 ? 1 : -1;
      const coords = this.view.coordsAtPos(this.position(current));
      const middle = (coords.top + coords.bottom) / 2 + direction * height;
      const bounds = this.bounds();
      // posAtCoords only reads what is on screen.
      if (middle < bounds.top || middle > bounds.bottom) dom.scrollTop += direction * height;
      const after = this.view.coordsAtPos(this.position(current));
      const left = goalColumn === undefined ? after.left : bounds.left + goalColumn;
      let next: Pos | null = null;
      // Block margins can sit between two visual lines.
      for (let step = 1; step <= VISUAL_LINE_PROBES && !next; step += 1) {
        const found = this.view.posAtCoords({
          left,
          top: (after.top + after.bottom) / 2 + (direction * height * step) / 2 + direction,
        });
        if (!found) continue;
        const candidate = this.view.coordsAtPos(found.pos);
        if (direction > 0 ? candidate.top >= after.bottom - 1 : candidate.bottom <= after.top + 1) {
          next = this.posFromPosition(found.pos);
        }
      }
      // Staying put is vim's answer at the edge; hitSide would ask the engine to re-seek.
      if (!next) return current;
      current = next;
    }
    return current;
  }
  charCoords(pos: VimPos) {
    const bounds = this.bounds();
    const coords = this.view.coordsAtPos(this.position(pos));
    const { scrollTop } = this.view.dom;
    return {
      left: coords.left - bounds.left,
      top: coords.top - bounds.top + scrollTop,
      bottom: coords.bottom - bounds.top + scrollTop,
    };
  }
  coordsChar(coords: { left: number; top: number }) {
    const bounds = this.bounds();
    const found = this.view.posAtCoords({
      left: coords.left + bounds.left,
      top: coords.top + bounds.top - this.view.dom.scrollTop,
    });
    return found ? this.posFromPosition(found.pos) : this.getCursor();
  }
  scrollIntoView() {
    this.view.dispatch(this.view.state.tr.scrollIntoView());
  }

  /** Mirrors CodeMirror's change batching, which `.` and macros read from. */
  onDocumentChange(tr: Transaction) {
    for (const marker of Object.values(this.marks))
      (marker as unknown as Marker).update(tr.mapping);
    for (const handle of this.lineHandles) {
      if (handle.position === null) continue;
      const result = tr.mapping.mapResult(handle.position, 1);
      handle.position = result.deletedAcross ? null : result.pos;
    }
    let from = Infinity;
    let to = -Infinity;
    tr.mapping.maps.forEach((map, index) => {
      const rest = tr.mapping.slice(index + 1);
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        from = Math.min(from, rest.map(newStart, -1));
        to = Math.max(to, rest.map(newEnd, 1));
      });
    });
    if (from === Infinity) return;
    const { flat } = this;
    const start = composerVimFlatOffset(flat, from);
    const end = composerVimFlatOffset(flat, to);
    this.recordChange(start, end);
  }
}

type RichEditor = Parameters<typeof splitOrLiftListItem>[0];

function runHistory(cm: ComposerVimEditor, step: typeof undo) {
  let changed: number | null = null;
  step(cm.view.state, (tr) => {
    changed = tr.mapping.maps.reduce<number | null>((first, map, index) => {
      let start = first;
      map.forEach((_oldStart, _oldEnd, newStart) => {
        const mapped = tr.mapping.slice(index + 1).map(newStart, -1);
        start = start === null ? mapped : Math.min(start, mapped);
      });
      return start;
    }, null);
    cm.view.dispatch(tr);
  });
  // Vim leaves the cursor at the start of the undone change.
  if (changed !== null) cm.setCursor(cm.posFromPosition(changed));
}

let activeSchema: Schema | null = null;

/** Chips leave as the prompt text they stand for; their placeholders mean nothing elsewhere. */
function clipboardText(text: string) {
  const schema = activeSchema;
  return text.replace(new RegExp(COMPOSER_VIM_ATOM_PATTERN, "gu"), (character) => {
    const json = composerVimAtomJson(character);
    if (!json || !schema) return character;
    const line = schema.node("paragraph", null, [schema.nodeFromJSON(json)]);
    return serializeEditorDoc(schema.node("doc", null, [line])).value;
  });
}

vimTextHooks.rememberRegisterText = rememberRegisterText;
vimTextHooks.clipboardText = clipboardText;

export { Vim };

function isDocumentEmpty(doc: ProseMirrorNode) {
  return doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0;
}

export function createComposerVimHost(view: EditorView): ComposerVimHost & {
  readonly editor: ComposerVimEditor;
  sendKey(key: string): unknown;
} {
  const cm = new ComposerVimEditor(view);
  // dd on a lone heading or list item leaves its marker unless the block goes too.
  const resetEmptiedBlock = () => {
    const { doc, schema, tr } = view.state;
    const paragraph = schema.nodes.paragraph!;
    if (doc.childCount !== 1 || doc.firstChild!.type === paragraph) return;
    if (doc.textContent.length > 0 || cm.getValue().length > 0) return;
    view.dispatch(tr.replaceWith(0, doc.content.size, paragraph.create()));
  };
  activeSchema = view.state.schema;
  const controller = createVimController(cm, {
    // Inputs nested in node views, such as citation comments, keep their own keys.
    ownsEvent: (event) => event.target === view.dom,
    setMode: (mode) => view.dispatch(setComposerVimState(view.state.tr, { mode })),
    afterKey: resetEmptiedBlock,
  });
  const { vim } = controller;

  return {
    editor: cm,
    sendKey: controller.handleKey,
    handleKeyDown: controller.handleKeyDown,
    onTransaction(transaction) {
      if (transaction.docChanged) cm.onDocumentChange(transaction);
      if (transaction.selectionSet || transaction.docChanged) cm.onSelectionChange();
      if (cm.curOp && !cm.curOp.isVimOp && cm.curOp.$d === 0) cm.endOperation();
      if (transaction.getMeta("preventUpdate")) controller.nextSession();
      if (controller.isInKey()) return;
      if (transaction.docChanged && isDocumentEmpty(transaction.doc)) controller.returnToInsert();
      else if (
        !cm.selecting &&
        !cm.pasting &&
        !vim().insertMode &&
        !vim().visualMode &&
        view.state.selection.empty
      ) {
        // A click past the last character would otherwise leave no cursor to act on.
        const cursor = cm.getCursor();
        const last = Math.max(0, cm.getLine(cursor.line).length - 1);
        if (cursor.ch > last) cm.setCursor(cursor.line, last);
      }
    },
    onCaretMoved() {
      // Vim also ends an undo step when the cursor moves during an insert.
      if (!controller.isInKey() && vim().insertMode) controller.nextSession();
    },
    onBlur: controller.onBlur,
    undoSession: controller.undoSession,
    destroy() {
      controller.destroy();
      if (view.isDestroyed) return;
      view.dispatch(setComposerVimState(view.state.tr, { mode: "insert", search: null }));
    },
  };
}

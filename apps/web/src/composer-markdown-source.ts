import { type Command, Extension, Mark as TiptapMark } from "@tiptap/core";
import {
  closeHistory,
  isHistoryTransaction,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@tiptap/pm/history";
import type { MarkType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  AllSelection,
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { type Mapping, StepMap } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import {
  inlineMarkdownUnitMarks,
  MARKDOWN_SOURCE_MARK,
  type RichTextMark,
} from "~/composer-rich-text";
import { caretTakesMarksBefore, serializeEditorDoc } from "~/composer-rich-text-doc";

// Styled text the selection touches becomes source text with the source mark,
// parsed back once the selection leaves. History steps only replay on the shape
// they were recorded in, so the history records both rewrites. Recording would
// clear redo after undo or redo, so until the next edit see `normalizeDetached`.

const STYLE_MARKS: RichTextMark[] = ["bold", "italic", "strike", "code"];
const PREVIEW_TAGS: Record<Exclude<RichTextMark, "code">, string> = {
  bold: "strong",
  italic: "em",
  strike: "s",
};
const ATOM_TEXT = "￼";
const DELIMITER = /[*_~`]/;

type TextRange = { from: number; to: number };

type StyledRange = TextRange & {
  escapedOpener: boolean;
  markers: { at: number; closing: boolean; text: string }[];
};

function collectStyledRanges(doc: ProseMirrorNode): StyledRange[] {
  const ranges: StyledRange[] = [];
  const map = serializeEditorDoc(doc);
  let range: StyledRange | null = null;
  let openLength = 0;
  for (const run of map.runs) {
    if (run.nodeName === "codeBlock") continue;
    if (run.openLen > 0) {
      let backslashes = 0;
      while (map.value[run.mdStart - backslashes - 1] === "\\") backslashes += 1;
      range ??= {
        from: run.pmPos,
        to: run.pmPos,
        escapedOpener: backslashes % 2 !== 0,
        markers: [],
      };
      range.markers.push({
        at: run.pmPos,
        closing: false,
        text: map.value.slice(run.mdStart, run.mdStart + run.openLen),
      });
    }
    if (range === null) continue;
    range.to = run.pmPos + run.docLen;
    if (run.closeLen > 0) {
      const end = run.mdStart + run.mdLen;
      range.markers.push({
        at: range.to,
        closing: true,
        text: map.value.slice(end - run.closeLen, end),
      });
    }
    openLength += run.openLen - run.closeLen;
    if (openLength === 0) {
      ranges.push(range);
      range = null;
    }
  }
  return ranges;
}

/** Whether the Markdown that reveal shows for `range` parses back to the same styles. */
function revealsFaithfully(doc: ProseMirrorNode, range: StyledRange): boolean {
  if (range.escapedOpener) return false;
  const adjacent = withAdjacentDelimiters(doc, range);
  if (adjacent.from !== range.from || adjacent.to !== range.to) return false;
  // Parsing keeps escapes as text, so styled `path\` or `2*3` stays styled, unshown.
  const markers = range.markers.toSorted(
    (left, right) => left.at - right.at || Number(right.closing) - Number(left.closing),
  );
  const expected: Array<RichTextMark[] | null> = [];
  let text = "";
  let next = 0;
  const addMarkers = (pos: number) => {
    for (; next < markers.length && markers[next]!.at <= pos; next++) {
      text += markers[next]!.text;
      expected.push(...markers[next]!.text.split("").map(() => null));
    }
  };
  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!node.isInline) return true;
    const marks = STYLE_MARKS.filter((name) => node.marks.some((mark) => mark.type.name === name));
    const from = Math.max(pos, range.from);
    const content = node.isText ? node.text!.slice(from - pos, range.to - pos) : ATOM_TEXT;
    for (let index = 0; index < content.length; index++) {
      addMarkers(from + index);
      text += content[index];
      expected.push(marks);
    }
    return false;
  });
  addMarkers(range.to);
  return inlineMarkdownUnitMarks(text).every((marks, index) => sameMarks(marks, expected[index]!));
}

function touches(selection: Selection, { from, to }: TextRange): boolean {
  return selection.empty
    ? selection.from >= from && selection.from <= to
    : selection.from < to && selection.to > from;
}

function sourceRegions(doc: ProseMirrorNode, type: MarkType): TextRange[] {
  const regions: TextRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let current: TextRange | null = null;
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (!type.isInSet(child.marks)) {
        current = null;
      } else if (current) {
        current.to = start + child.nodeSize;
      } else {
        current = { from: start, to: start + child.nodeSize };
        regions.push(current);
      }
    });
    return false;
  });
  return regions;
}

/** Takes in delimiters typed beside the source, like a closing `**` retyped after its text. */
function withAdjacentDelimiters(doc: ProseMirrorNode, region: TextRange): TextRange {
  const before = doc.resolve(region.from).nodeBefore;
  const after = doc.resolve(region.to).nodeAfter;
  let from = region.from;
  let to = region.to;
  if (before?.isText && before.marks.length === 0) {
    const text = before.text!;
    let count = 0;
    while (count < text.length && DELIMITER.test(text[text.length - 1 - count]!)) count += 1;
    // Only an odd backslash run escapes the first adjacent delimiter.
    let backslashes = 0;
    while (text[text.length - 1 - count - backslashes] === "\\") backslashes += 1;
    if (count > 0 && backslashes % 2 === 1) count -= 1;
    from -= count;
  }
  if (after?.isText && after.marks.length === 0) {
    const text = after.text!;
    let count = 0;
    while (count < text.length && DELIMITER.test(text[count]!)) count += 1;
    to += count;
  }
  return { from, to };
}

function sameMarks(left: RichTextMark[] | null, right: RichTextMark[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((mark) => right.includes(mark));
}

/** Calls `visit` for each run of units that parse the same way. */
function forEachUnitRun(
  units: ReadonlyArray<RichTextMark[] | null>,
  visit: (start: number, end: number, marks: RichTextMark[] | null) => void,
): void {
  let start = 0;
  while (start < units.length) {
    let end = start + 1;
    while (end < units.length && sameMarks(units[end]!, units[start]!)) end += 1;
    visit(start, end, units[start]!);
    start = end;
  }
}

function regionUnits(doc: ProseMirrorNode, { from, to }: TextRange) {
  const text = doc.textBetween(from, to, undefined, ATOM_TEXT);
  return { text, units: inlineMarkdownUnitMarks(text) };
}

function collapseRegion(tr: Transaction, region: TextRange, type: MarkType): void {
  const { schema } = tr.doc.type;
  const { units } = regionUnits(tr.doc, region);
  tr.removeMark(region.from, region.to, type);
  forEachUnitRun(units, (start, end, marks) => {
    for (const name of marks ?? []) {
      const markType = schema.marks[name];
      if (markType) tr.addMark(region.from + start, region.from + end, markType.create());
    }
  });
  const deletions: TextRange[] = [];
  forEachUnitRun(units, (start, end, marks) => {
    if (marks === null) deletions.push({ from: region.from + start, to: region.from + end });
  });
  for (const { from, to } of deletions.toReversed()) tr.delete(from, to);
}

/** Parses source the selection does not touch back into marks, in place. */
function collapseMarkdownSource(
  tr: Transaction,
  keep: (region: TextRange) => boolean = () => false,
): void {
  const type = tr.doc.type.schema.marks[MARKDOWN_SOURCE_MARK];
  if (!type) return;
  const regions: TextRange[] = [];
  for (const region of sourceRegions(tr.doc, type)) {
    const extended = withAdjacentDelimiters(tr.doc, region);
    const previous = regions.at(-1);
    if (previous && extended.from <= previous.to) previous.to = Math.max(previous.to, extended.to);
    else regions.push(extended);
  }
  for (const region of regions.toReversed()) {
    if (keep(region)) tr.addMark(region.from, region.to, type.create());
    else collapseRegion(tr, region, type);
  }
}

function mapSelection(tr: Transaction, selection: Selection, map: (pos: number) => number) {
  if (selection instanceof AllSelection) return new AllSelection(tr.doc);
  if (selection instanceof NodeSelection) {
    const pos = map(selection.from);
    if (tr.doc.nodeAt(pos)) return NodeSelection.create(tr.doc, pos);
  }
  return TextSelection.create(tr.doc, map(selection.anchor), map(selection.head));
}

/** Parses all shown source first, so a command that splits it keeps its styles. */
export const collapseShownMarkdownSource: Command = ({ tr }) => {
  collapseMarkdownSource(tr);
  return true;
};

function mapRange(mapping: Mapping, { from, to }: TextRange): TextRange {
  return { from: mapping.map(from, 1), to: mapping.map(to, -1) };
}

/** Shows styled text the selection touches as Markdown, returning the source it added. */
function revealStyledText(tr: Transaction, type: MarkType, typed: boolean, takesBefore: boolean) {
  const { schema } = tr.doc.type;
  const selection = tr.selection;
  const ranges = collectStyledRanges(tr.doc).filter(
    (range) => touches(selection, range) && revealsFaithfully(tr.doc, range),
  );
  const revealed: { range: TextRange; step: number }[] = [];
  const insertions: { at: number; length: number; closing: boolean }[] = [];
  for (const range of ranges.toReversed()) {
    for (const name of STYLE_MARKS) {
      const markType = schema.marks[name];
      if (markType) tr.removeMark(range.from, range.to, markType);
    }
    let length = 0;
    // Inserting from the end keeps earlier positions valid; at a shared
    // position the opening marker goes in first so the closing one ends up before it.
    const markers = range.markers.toSorted(
      (left, right) => right.at - left.at || Number(left.closing) - Number(right.closing),
    );
    for (const { at, closing, text } of markers) {
      tr.insert(at, schema.text(text, [type.create()]));
      insertions.push({ at, length: text.length, closing });
      length += text.length;
    }
    tr.addMark(range.from, range.to + length, type.create());
    revealed.push({ range: { from: range.from, to: range.to + length }, step: tr.steps.length });
  }
  if (ranges.length === 0) return [];
  // A caret that arrives at a styled edge stays outside its markers. One that
  // just typed styled text stays inside them, so the next character continues it.
  const map = (pos: number) => {
    let next = pos;
    for (const { at, length, closing } of insertions) {
      const inside = typed && selection.empty && (closing ? takesBefore : !takesBefore);
      if (at < pos || (at === pos && (selection instanceof NodeSelection || closing !== inside))) {
        next += length;
      }
    }
    return next;
  };
  tr.setSelection(mapSelection(tr, selection, map));
  return revealed.map(({ range, step }) => mapRange(tr.mapping.slice(step), range));
}

/** Shows styled text the selection touches as Markdown, and parses source it left. */
function normalizeMarkdownSource(state: EditorState, typed: boolean): Transaction | null {
  const type = state.schema.marks[MARKDOWN_SOURCE_MARK];
  if (!type) return null;
  const tr = state.tr;
  collapseMarkdownSource(tr, (region) => touches(state.selection, region));
  revealStyledText(tr, type, typed, caretTakesMarksBefore(state));
  return tr.docChanged ? tr : null;
}

/**
 * After undo or redo, history items may point inside shown source, and a
 * rewrite in the history would clear redo. So until the next recorded edit,
 * rewrites stay out of it and only remove text they added: source the history
 * knows is hidden instead of parsed, and source revealed here is parsed back.
 */
function normalizeDetached(state: EditorState, revealed: TextRange[]): Transaction | null {
  const type = state.schema.marks[MARKDOWN_SOURCE_MARK];
  if (!type) return null;
  const tr = state.tr;
  const kept: TextRange[] = [];
  for (const region of revealed.toSorted((left, right) => right.from - left.from)) {
    if (touches(state.selection, region)) kept.push(region);
    else collapseRegion(tr, region, type);
  }
  const added = revealStyledText(tr, type, false, caretTakesMarksBefore(state));
  if (!tr.docChanged) return null;
  const shown = [...kept.map((region) => mapRange(tr.mapping, region)), ...added];
  return tr.setMeta(markdownSourceKey, shown).setMeta("addToHistory", false);
}

/** Parses the source `normalizeDetached` revealed, leaving the document the history knows. */
function collapseRevealed(state: EditorState, revealed: TextRange[]): Transaction {
  const tr = state.tr;
  const type = state.schema.marks[MARKDOWN_SOURCE_MARK];
  if (type) {
    for (const region of revealed.toSorted((left, right) => right.from - left.from)) {
      collapseRegion(tr, region, type);
    }
  }
  return tr.setMeta(markdownSourceKey, []).setMeta("addToHistory", false);
}

/** Replays `edit` after undoing `collapse`, so the history records the reveal with the edit. */
function rebaseEdit(tr: Transaction, collapse: Transaction, edit: Transaction): Transaction {
  for (let index = collapse.steps.length - 1; index >= 0; index--) {
    tr.step(collapse.steps[index]!.invert(collapse.docs[index]!));
  }
  for (const step of edit.steps) tr.step(step);
  tr.setSelection(edit.selection.map(tr.doc, StepMap.empty)).setTime(edit.time);
  if (edit.storedMarksSet) tr.setStoredMarks(edit.storedMarks);
  if (edit.scrolledIntoView) tr.scrollIntoView();
  // Metadata has no public accessor, and grouping, paste rules and composition read it.
  type WithMeta = { meta: Record<string, unknown> };
  Object.assign((tr as unknown as WithMeta).meta, (edit as unknown as WithMeta).meta);
  return tr;
}

const replayKey = new PluginKey("composer-markdown-source-replay");

/**
 * Replays the edit a request carries after the source plugin appended its collapse,
 * in the request's one view update so an IME keeps its preedit. History ignores what
 * is appended to an unrecorded transaction, so the request itself records nothing.
 */
const replayPlugin = new Plugin({
  key: replayKey,
  appendTransaction([request, collapse], _, state) {
    const edit = request?.getMeta(replayKey) as Transaction | undefined;
    // Appended transactions otherwise join the previous undo event.
    return edit && collapse ? closeHistory(rebaseEdit(state.tr, collapse, edit)) : null;
  },
});

function previewDecorations(
  doc: ProseMirrorNode,
  type: MarkType,
  hidden: Selection | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const region of sourceRegions(doc, type)) {
    const hide = hidden !== null && !touches(hidden, region);
    const { text, units } = regionUnits(doc, region);
    const codeTicks = new Set<number>();
    forEachUnitRun(units, (start, end, marks) => {
      for (const name of marks ?? []) {
        if (name !== "code") {
          decorations.push(
            Decoration.inline(region.from + start, region.from + end, {
              nodeName: PREVIEW_TAGS[name],
            }),
          );
          continue;
        }
        // One element holds the ticks and the code, so a right-to-left line
        // keeps both ticks on their own sides of it.
        let from = start;
        let to = end;
        if (units[from - 1] === null && text[from - 1] === "`") codeTicks.add((from -= 1));
        if (units[to] === null && text[to] === "`") codeTicks.add(to++);
        decorations.push(
          Decoration.inline(region.from + from, region.from + to, { nodeName: "code", dir: "ltr" }),
        );
      }
    });
    forEachUnitRun(
      units.map((marks, index) => (marks === null && (hide || !codeTicks.has(index)) ? null : [])),
      (start, end, marks) => {
        if (marks !== null) return;
        decorations.push(
          Decoration.inline(region.from + start, region.from + end, {
            class: hide ? "composer-rich-marker-hidden" : "composer-rich-marker",
          }),
        );
      },
    );
  }
  return DecorationSet.create(doc, decorations);
}

type MarkdownSourceState = {
  decorations: DecorationSet;
  /** From an undo or redo until the next recorded edit; see `normalizeDetached`. */
  detached: boolean;
  /** Source `normalizeDetached` revealed, which the history knows as styled text. */
  revealed: TextRange[];
};

const markdownSourceKey = new PluginKey<MarkdownSourceState>("composer-markdown-source");

function markdownSourcePlugin(type: MarkType): Plugin<MarkdownSourceState> {
  let view: EditorView | null = null;
  return new Plugin<MarkdownSourceState>({
    key: markdownSourceKey,
    view(editorView) {
      view = editorView;
      return {
        destroy() {
          view = null;
        },
      };
    },
    state: {
      init: (_, state) => ({
        decorations: previewDecorations(state.doc, type, null),
        detached: false,
        revealed: [],
      }),
      apply: (tr, old, _, state) => {
        const history = isHistoryTransaction(tr);
        const detached =
          history || (old.detached && !(tr.docChanged && tr.getMeta("addToHistory") !== false));
        const own = tr.getMeta(markdownSourceKey) as TextRange[] | undefined;
        const revealed =
          !detached || history
            ? []
            : (own ??
              (tr.docChanged
                ? old.revealed.map((range) => mapRange(tr.mapping, range))
                : old.revealed));
        const redraw = tr.docChanged || detached !== old.detached || (detached && tr.selectionSet);
        return {
          decorations: redraw
            ? previewDecorations(state.doc, type, detached ? state.selection : null)
            : old.decorations,
          detached,
          revealed,
        };
      },
    },
    props: {
      decorations: (state) => markdownSourceKey.getState(state)?.decorations,
    },
    appendTransaction(transactions, _, state) {
      if (transactions[0]?.getMeta(replayKey)) {
        return collapseRevealed(state, markdownSourceKey.getState(state)?.revealed ?? []);
      }
      // Rewriting text mid-composition would break the IME's preedit.
      if (view?.composing) return null;
      // Rewrites appended to an undo or redo join its history step, which leaves
      // the other direction unmapped. The dispatch hook normalizes after it instead.
      if (transactions.some((tr) => isHistoryTransaction(tr) || tr.getMeta(markdownSourceKey))) {
        return null;
      }
      if (!transactions.some((tr) => tr.docChanged || tr.selectionSet)) return null;
      const source = markdownSourceKey.getState(state);
      if (source?.detached) return normalizeDetached(state, source.revealed);
      const tr = normalizeMarkdownSource(
        state,
        transactions.some((item) => item.docChanged),
      );
      // With nothing to undo, a recorded rewrite would only add a no-op undo.
      if (tr && undoDepth(state) === 0) tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}

/** Keeps source `normalizeDetached` revealed out of what undo, redo and edits see. */
const MarkdownSourceHistoryExtension = Extension.create({
  name: "composer-markdown-source-history",
  // Runs after undo grouping, so a rebased edit keeps the grouping chosen for it.
  priority: 1,
  dispatchTransaction({ transaction, next }) {
    const { editor } = this;
    const revealed = markdownSourceKey.getState(editor.state)?.revealed ?? [];
    if (isHistoryTransaction(transaction)) {
      if (revealed.length === 0) {
        next(transaction);
      } else {
        const undoing = redoDepth(editor.state.apply(transaction)) > redoDepth(editor.state);
        next(collapseRevealed(editor.state, revealed));
        (undoing ? undo : redo)(editor.state, next);
      }
      const source = markdownSourceKey.getState(editor.state);
      const tr = editor.view.composing
        ? null
        : normalizeDetached(editor.state, source?.revealed ?? []);
      if (tr) next(tr);
      return;
    }
    const recordedEdit =
      transaction.docChanged &&
      transaction.getMeta("addToHistory") !== false &&
      transaction.getMeta(markdownSourceKey) === undefined;
    if (revealed.length === 0 || !recordedEdit) {
      next(transaction);
      return;
    }
    next(editor.state.tr.setMeta(replayKey, transaction));
  },
});

export const ComposerMarkdownSourceExtension = TiptapMark.create({
  name: MARKDOWN_SOURCE_MARK,
  // Its shortcuts run ahead of the style marks' own.
  priority: 1001,
  inclusive: false,
  parseHTML() {
    return [{ tag: "span.composer-markdown-source" }];
  },
  renderHTML() {
    return ["span", { class: "composer-markdown-source" }, 0];
  },
  addKeyboardShortcuts() {
    // Shown markers are plain text, so toggling a style there would wrap them
    // in another style. Parse the source first and toggle the result.
    const toggle = (name: RichTextMark) => () => {
      const { state } = this.editor;
      const { selection } = state;
      const touched = sourceRegions(state.doc, this.type).some((region) => {
        if (!touches(selection, region)) return false;
        if (!selection.empty) return true;
        // Typing next to a marker would land in the markers. Elsewhere Tiptap's own
        // toggle nests the style inside the source correctly.
        const { units } = regionUnits(state.doc, region);
        const offset = selection.from - region.from;
        return units[offset - 1] === null || units[offset] === null;
      });
      if (!touched) return false;
      return this.editor.chain().command(collapseShownMarkdownSource).toggleMark(name).run();
    };
    return {
      "Mod-b": toggle("bold"),
      "Mod-B": toggle("bold"),
      "Mod-i": toggle("italic"),
      "Mod-I": toggle("italic"),
      "Mod-Shift-s": toggle("strike"),
      "Mod-e": toggle("code"),
    };
  },
  addExtensions() {
    return [MarkdownSourceHistoryExtension];
  },
  addProseMirrorPlugins() {
    return [markdownSourcePlugin(this.type), replayPlugin];
  },
});

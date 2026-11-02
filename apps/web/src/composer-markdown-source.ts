import { Mark as TiptapMark } from "@tiptap/core";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
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
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import {
  inlineMarkdownUnitMarks,
  MARKDOWN_SOURCE_MARK,
  type RichTextMark,
} from "~/composer-rich-text";
import { caretTakesMarksBefore, serializeEditorDoc } from "~/composer-rich-text-doc";

// Styled text the selection touches becomes source text carrying the source
// mark, parsed back into marks once the selection leaves. The history records
// both rewrites (appended to the moving transaction), so undo lands on states
// already in this shape. Without history yet, recording them only adds no-op undos.

const STYLE_MARKS: RichTextMark[] = ["bold", "italic", "strike", "code"];
const PREVIEW_TAGS: Record<Exclude<RichTextMark, "code">, string> = {
  bold: "strong",
  italic: "em",
  strike: "s",
};
const ATOM_TEXT = "￼";
const DELIMITER = /[*_~`]/;

type TextRange = { from: number; to: number };

type StyledRange = TextRange & { markers: { at: number; closing: boolean; text: string }[] };

function collectStyledRanges(doc: ProseMirrorNode): StyledRange[] {
  const ranges: StyledRange[] = [];
  const map = serializeEditorDoc(doc);
  let range: StyledRange | null = null;
  let openLength = 0;
  for (const run of map.runs) {
    if (run.nodeName === "codeBlock") continue;
    if (run.openLen > 0) {
      range ??= { from: run.pmPos, to: run.pmPos, markers: [] };
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
    // A backslash escapes the delimiter after it.
    if (count > 0 && text[text.length - 1 - count] === "\\") count -= 1;
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

/** Shows styled text the selection touches as Markdown, and parses source it left. */
function normalizeMarkdownSource(state: EditorState, typed: boolean): Transaction | null {
  const type = state.schema.marks[MARKDOWN_SOURCE_MARK];
  if (!type) return null;
  const tr = state.tr;
  collapseMarkdownSource(tr, (region) => touches(state.selection, region));
  const selection = tr.selection;
  const ranges = collectStyledRanges(tr.doc).filter((range) => touches(selection, range));
  if (ranges.length === 0) return tr.docChanged ? tr : null;

  const takesBefore = caretTakesMarksBefore(state);
  const insertions: { at: number; length: number; closing: boolean }[] = [];
  for (const range of ranges.toReversed()) {
    for (const name of STYLE_MARKS) {
      const markType = state.schema.marks[name];
      if (markType) tr.removeMark(range.from, range.to, markType);
    }
    let length = 0;
    // Inserting from the end keeps earlier positions valid; at a shared
    // position the opening marker goes in first so the closing one ends up before it.
    const markers = range.markers.toSorted(
      (left, right) => right.at - left.at || Number(left.closing) - Number(right.closing),
    );
    for (const { at, closing, text } of markers) {
      tr.insert(at, state.schema.text(text, [type.create()]));
      insertions.push({ at, length: text.length, closing });
      length += text.length;
    }
    tr.addMark(range.from, range.to + length, type.create());
  }
  // A caret that arrives at a styled edge stays outside its markers. One that
  // just typed styled text stays inside them, so the next character continues it.
  const map = (pos: number) => {
    let next = pos;
    for (const { at, length, closing } of insertions) {
      const inside = typed && selection.empty && (closing ? takesBefore : !takesBefore);
      if (at < pos || (at === pos && closing !== inside)) next += length;
    }
    return next;
  };
  return tr.setSelection(mapSelection(tr, selection, map));
}

function previewDecorations(doc: ProseMirrorNode, type: MarkType): DecorationSet {
  const decorations: Decoration[] = [];
  for (const region of sourceRegions(doc, type)) {
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
      units.map((marks, index) => (marks === null && !codeTicks.has(index) ? null : [])),
      (start, end, marks) => {
        if (marks !== null) return;
        decorations.push(
          Decoration.inline(region.from + start, region.from + end, {
            class: "composer-rich-marker",
          }),
        );
      },
    );
  }
  return DecorationSet.create(doc, decorations);
}

const markdownSourceKey = new PluginKey<DecorationSet>("composer-markdown-source");

function markdownSourcePlugin(type: MarkType): Plugin<DecorationSet> {
  let view: EditorView | null = null;
  return new Plugin<DecorationSet>({
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
      init: (_, state) => previewDecorations(state.doc, type),
      apply: (tr, old, _, state) => (tr.docChanged ? previewDecorations(state.doc, type) : old),
    },
    props: {
      decorations: (state) => markdownSourceKey.getState(state),
    },
    appendTransaction(transactions, _, state) {
      // Rewriting text mid-composition would break the IME's preedit.
      if (view?.composing) return null;
      if (!transactions.some((tr) => tr.docChanged || tr.selectionSet)) return null;
      const tr = normalizeMarkdownSource(
        state,
        transactions.some((item) => item.docChanged),
      );
      if (tr && undoDepth(state) === 0 && redoDepth(state) === 0) tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}

export const ComposerMarkdownSourceExtension = TiptapMark.create({
  name: MARKDOWN_SOURCE_MARK,
  // Its shortcuts run ahead of the style marks' own.
  priority: 1001,
  inclusive: false,
  parseHTML() {
    return [];
  },
  renderHTML() {
    return ["span", { class: "composer-markdown-source" }, 0];
  },
  addKeyboardShortcuts() {
    // Shown markers are plain text, so toggling a style there would wrap them
    // in another style. Parse the source first and toggle the result.
    const toggle = (name: RichTextMark) => () => {
      const { state } = this.editor;
      if (state.selection.empty) return false;
      const touched = sourceRegions(state.doc, this.type).some((region) =>
        touches(state.selection, region),
      );
      if (!touched) return false;
      return this.editor
        .chain()
        .command(({ tr }) => {
          collapseMarkdownSource(tr);
          return true;
        })
        .toggleMark(name)
        .run();
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
  addProseMirrorPlugins() {
    return [markdownSourcePlugin(this.type)];
  },
});

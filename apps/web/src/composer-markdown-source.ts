import { toggleMark } from "@tiptap/pm/commands";
import { composerMathRanges } from "@t3tools/shared/composerInlineTokens";
import type { MarkType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { keydownHandler } from "@tiptap/pm/keymap";
import { Decoration, type DecorationAttrs, DecorationSet } from "@tiptap/pm/view";

import { caretLineDirection } from "~/composer-text-direction";
import { parseInlineMarkdown, type RichTextMark } from "~/composer-rich-text";
import { caretTakesMarksBefore, serializeEditorDoc } from "~/composer-rich-text-doc";

type Range = { from: number; to: number };

const FORMATTING_MARKS: readonly RichTextMark[] = ["bold", "italic", "strike", "code"];

const MARK_TAGS: Record<RichTextMark, string> = {
  bold: "strong",
  italic: "em",
  strike: "s",
  code: "code",
};

const ATOM_CHAR = String.fromCodePoint(0xfffc);

const sourceKey = new PluginKey<DecorationSet>("composer-markdown-source");

type StyledRange = Range & { markers: { at: number; text: string }[] };

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
        text: map.value.slice(run.mdStart, run.mdStart + run.openLen),
      });
    }
    if (range === null) continue;
    range.to = run.pmPos + run.docLen;
    if (run.closeLen > 0) {
      const end = run.mdStart + run.mdLen;
      range.markers.push({ at: range.to, text: map.value.slice(end - run.closeLen, end) });
    }
    openLength += run.openLen - run.closeLen;
    if (openLength === 0) {
      ranges.push(range);
      range = null;
    }
  }
  return ranges;
}

type SourcePiece = Range & { char: string; marks: RichTextMark[] | null };

/**
 * Parses the source in [from, to] the way a restored draft is parsed. Pieces
 * with null marks are the Markdown markers; the rest keep their text.
 */
function parseSource(doc: ProseMirrorNode, from: number, to: number): SourcePiece[] {
  const units: (Range & { char: string })[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      for (let at = start; at < end; at += 1) {
        units.push({ from: at, to: at + 1, char: node.text![at - pos]! });
      }
    } else if (node.isInline) {
      units.push({
        from: pos,
        to: pos + node.nodeSize,
        char: node.type.name === "hardBreak" ? "\n" : ATOM_CHAR,
      });
    }
    return !node.isInline;
  });
  // Formulas stay literal, as they do when a draft is restored.
  const text = units.map((unit) => unit.char).join("");
  const groups: (Range & { char: string })[] = [];
  let index = 0;
  for (const formula of composerMathRanges(text)) {
    for (let at = index; at < formula.start; at += 1) groups.push(units[at]!);
    groups.push({
      from: units[formula.start]!.from,
      to: units[formula.end - 1]!.to,
      char: ATOM_CHAR,
    });
    index = formula.end;
  }
  for (let at = index; at < units.length; at += 1) groups.push(units[at]!);

  const pieces: SourcePiece[] = groups.map((group) => ({ ...group, marks: null }));
  for (const span of parseInlineMarkdown(groups.map((group) => group.char).join(""), {
    underscoreItalic: false,
    sourceOffsets: true,
  })) {
    for (const offset of span.sourceOffsets!) pieces[offset]!.marks = span.marks;
  }
  return pieces;
}

function textblockRanges(doc: ProseMirrorNode, range: Range): Range[] {
  const ranges: Range[] = [];
  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (!node.type.spec.code) {
      const from = Math.max(range.from, pos + 1);
      const to = Math.min(range.to, pos + 1 + node.content.size);
      if (from < to) ranges.push({ from, to });
    }
    return false;
  });
  return ranges;
}

function markTypes(doc: ProseMirrorNode): MarkType[] {
  return FORMATTING_MARKS.flatMap((mark) => doc.type.schema.marks[mark] ?? []);
}

function fold(tr: Transaction, source: Range): void {
  const types = markTypes(tr.doc);
  for (const block of textblockRanges(tr.doc, source).toReversed()) {
    const pieces = parseSource(tr.doc, block.from, block.to);
    for (const type of types) tr.removeMark(block.from, block.to, type);
    for (const piece of pieces) {
      for (const mark of piece.marks ?? []) {
        const type = tr.doc.type.schema.marks[mark];
        if (type) tr.addMark(piece.from, piece.to, type.create());
      }
    }
    for (const piece of pieces.toReversed()) {
      if (piece.marks === null) tr.delete(piece.from, piece.to);
    }
  }
}

function touches(selection: Range, range: Range): boolean {
  return selection.from <= range.to && selection.to >= range.from;
}

function sourceTransaction(state: EditorState): Transaction | null {
  const ranges = collectStyledRanges(state.doc);
  if (ranges.length === 0) return null;
  const tr = state.tr;
  const inserts = new Map<number, string>();
  for (const range of ranges) {
    for (const { at, text } of range.markers) inserts.set(at, (inserts.get(at) ?? "") + text);
  }
  for (const at of [...inserts.keys()].toSorted((a, b) => b - a)) {
    tr.insert(at, state.schema.text(inserts.get(at)!));
  }
  for (const range of ranges) {
    for (const type of markTypes(tr.doc)) {
      tr.removeMark(tr.mapping.map(range.from, -1), tr.mapping.map(range.to, 1), type);
    }
  }
  if (state.selection.empty) {
    const side = caretTakesMarksBefore(state) ? -1 : 1;
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(state.selection.head, side)));
  } else if (state.selection instanceof TextSelection) {
    const { anchor, head } = state.selection;
    const forward = anchor < head;
    tr.setSelection(
      TextSelection.create(
        tr.doc,
        tr.mapping.map(anchor, forward ? 1 : -1),
        tr.mapping.map(head, forward ? -1 : 1),
      ),
    );
  }
  return tr;
}

function decorate(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const decorations: Decoration[] = [];
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name.startsWith("composer-")) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, { class: "composer-chip-range-selected" }),
        );
        return false;
      }
      return true;
    });
  }
  const blocks = state.schema.marks.bold
    ? textblockRanges(doc, { from: 0, to: doc.content.size })
    : [];
  for (const block of blocks) {
    const pieces = parseSource(doc, block.from, block.to);
    // Backticks join their code's element, so code stays one left-to-right isolate.
    const styles = pieces.map((piece) => piece.marks);
    for (let first = 0; first < pieces.length;) {
      const isCodeMarker = (index: number) =>
        pieces[index]?.marks === null && /^[` ]$/.test(pieces[index]!.char);
      if (!isCodeMarker(first)) {
        first += 1;
        continue;
      }
      let last = first + 1;
      while (isCodeMarker(last)) last += 1;
      const code = [pieces[first - 1], pieces[last]].find((piece) =>
        piece?.marks?.includes("code"),
      );
      if (code) for (let index = first; index < last; index += 1) styles[index] = code.marks;
      first = last;
    }
    const runs = (has: (index: number) => boolean, attrs: DecorationAttrs) => {
      let start = -1;
      for (let index = 0; index <= pieces.length; index += 1) {
        if (index < pieces.length && has(index)) {
          if (start === -1) start = index;
        } else if (start !== -1) {
          decorations.push(Decoration.inline(pieces[start]!.from, pieces[index - 1]!.to, attrs));
          start = -1;
        }
      }
    };
    const active = { from: selection.from, to: selection.to };
    if (selection.empty && block.from <= selection.from && selection.to <= block.to) {
      const before = doc.textBetween(block.from, selection.from, "\n", ATOM_CHAR);
      const after = doc.textBetween(selection.to, block.to, "\n", ATOM_CHAR);
      active.from -= before.match(/\S*$/)![0].length;
      active.to += after.match(/^\S*/)![0].length;
    }
    const hidden = new Set<number>();
    let first = 0;
    while (first < pieces.length) {
      if (pieces[first]!.marks?.length === 0) {
        first += 1;
        continue;
      }
      let last = first + 1;
      while (last < pieces.length && pieces[last]!.marks?.length !== 0) last += 1;
      if (!touches(active, { from: pieces[first]!.from, to: pieces[last - 1]!.to })) {
        for (let index = first; index < last; index += 1) hidden.add(index);
      }
      first = last;
    }
    runs((index) => styles[index] === null && !hidden.has(index), {
      class: "composer-rich-marker",
    });
    runs((index) => pieces[index]!.marks === null && hidden.has(index), {
      class: "composer-rich-marker-hidden",
    });
    for (const mark of FORMATTING_MARKS) {
      runs(
        (index) => styles[index]?.includes(mark) === true,
        mark === "code" ? { nodeName: MARK_TAGS[mark], dir: "ltr" } : { nodeName: MARK_TAGS[mark] },
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

const sourceMarkKeys = keydownHandler(
  Object.fromEntries(
    (
      [
        ["Mod-b", "bold"],
        ["Mod-B", "bold"],
        ["Mod-i", "italic"],
        ["Mod-I", "italic"],
        ["Mod-Shift-s", "strike"],
        ["Mod-e", "code"],
      ] as const
    ).map(([key, mark]) => [
      key,
      (state: EditorState, dispatch?: (tr: Transaction) => void) => {
        const { selection } = state;
        if (
          selection.empty ||
          !selection.$from.parent.isTextblock ||
          !selection.$to.parent.isTextblock
        )
          return false;
        const source = { from: selection.$from.start(), to: selection.$to.end() };
        const tr = state.tr;
        fold(tr, source);
        const type = state.schema.marks[mark];
        if (!type) return false;
        return toggleMark(type)(
          EditorState.create({ doc: tr.doc, selection: tr.selection }),
          (marked) => {
            for (const step of marked.steps) tr.step(step);
            tr.setSelection(marked.selection.getBookmark().resolve(tr.doc));
            dispatch?.(tr);
          },
        );
      },
    ]),
  ),
);

export function sourceRangeHasFormatting(doc: ProseMirrorNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    if (!node.type.spec.code) {
      found = parseSource(doc, pos + 1, pos + 1 + node.content.size).some(
        (piece) =>
          piece.from < to && piece.to > from && (piece.marks === null || piece.marks.length > 0),
      );
    }
    return false;
  });
  return found;
}

export const ComposerMarkdownSourcePlugin = new Plugin<DecorationSet>({
  key: sourceKey,
  state: {
    init: (_, state) => decorate(state),
    apply: (tr, previous, _, state) =>
      tr.docChanged || tr.selectionSet ? decorate(state) : previous,
  },
  appendTransaction(transactions, _oldState, state) {
    if (transactions.some((tr) => tr.getMeta("composition") !== undefined)) return null;
    if (!transactions.some((tr) => tr.docChanged)) return null;
    const tr = sourceTransaction(state);
    if (!tr) return null;
    // Input rules and formatting shortcuts must undo together with their source conversion.
    return transactions.some((tr) => tr.docChanged && tr.getMeta("addToHistory") !== false)
      ? tr
      : tr.setMeta("addToHistory", false);
  },
  props: {
    handleTextInput(view, from, _to, _text, defaultTr) {
      const $from = view.state.doc.resolve(from);
      if (!view.state.schema.marks.code || !$from.parent.isTextblock || $from.parent.type.spec.code)
        return false;
      const insideCode = parseSource(view.state.doc, $from.start(), $from.end()).some(
        (piece) => piece.from <= from && from <= piece.to && piece.marks?.includes("code"),
      );
      if (!insideCode) return false;
      // Source has no native code mark to suppress Markdown input rules.
      view.dispatch(defaultTr());
      return true;
    },
    handleKeyDown(view, event) {
      const { state } = view;
      const { selection } = state;
      if (
        state.schema.marks.bold &&
        selection.empty &&
        selection.$head.parent.isTextblock &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        const back = caretLineDirection(state) === "rtl" ? "ArrowRight" : "ArrowLeft";
        const target = selection.head + (event.key === back ? -1 : 1);
        const marker = parseSource(state.doc, selection.$head.start(), selection.$head.end()).some(
          (piece) => piece.marks === null && piece.from <= target && target <= piece.to,
        );
        if (marker) {
          view.dispatch(
            state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView(),
          );
          return true;
        }
      }
      return sourceMarkKeys(view, event);
    },
    decorations: (state) => sourceKey.getState(state),
  },
});

import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";

/**
 * Spaces rather than a tab: the fence round-trips through Markdown on its way
 * to the agent, and a literal tab there renders at whatever width the reader
 * happens to use. Two matches how this repo indents its own source.
 */
export const CODE_BLOCK_INDENT = "  ";

/** The leading run of spaces and tabs on a line, which Enter carries forward. */
export function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Removes one indent's worth of leading whitespace, tolerating lines that were
 * indented by hand with an odd number of spaces or with tabs. A line with no
 * leading whitespace is returned unchanged, so outdenting bottoms out quietly
 * rather than eating the first character of code.
 */
export function outdentLine(line: string): string {
  if (line.startsWith(CODE_BLOCK_INDENT)) return line.slice(CODE_BLOCK_INDENT.length);
  if (line.startsWith("\t")) return line.slice(1);
  if (line.startsWith(" ")) return line.slice(1);
  return line;
}

/** Applies Tab/Shift+Tab to every line a selection touches, whole lines at a time. */
export function indentLines(lines: ReadonlyArray<string>, direction: "in" | "out"): string[] {
  return lines.map((line) => {
    // Indenting a blank line would leave trailing whitespace behind on a line
    // the user cannot see the caret move on, so leave it be.
    if (direction === "in") return line.length === 0 ? line : `${CODE_BLOCK_INDENT}${line}`;
    return outdentLine(line);
  });
}

/**
 * Where the code block containing the selection starts, or null when the
 * selection is outside a fence or spans out of one. Both ends must sit in the
 * same block: a selection that reaches past the fence belongs to the document,
 * not to the code.
 */
/** Whether every endpoint of the selection sits in the same code block. */
export function selectionInOneCodeBlock(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  return $from.parent.type.spec.code === true && $from.sameParent($to);
}

function codeBlockRange(
  state: EditorState,
): { readonly from: number; readonly to: number; readonly text: string } | null {
  const { $from, $to } = state.selection;
  const parent = $from.parent;
  if (parent.type.spec.code !== true) return null;
  // Same occurrence, not merely equal structure: two identical fences would
  // otherwise let a selection across them edit through the block boundary.
  if (!$from.sameParent($to)) return null;
  const from = $from.start();
  return { from, to: from + parent.content.size, text: parent.textContent };
}

/**
 * Enter inside a fence, carrying the current line's indentation onto the new
 * line. ProseMirror's default splits the text but starts the new line at column
 * zero, which means re-typing the indent on every line of a nested block.
 */
export function indentedNewlineInCodeBlock(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const block = codeBlockRange(state);
  if (!block) return false;

  const { from, to } = state.selection;
  const beforeCursor = block.text.slice(0, from - block.from);
  const currentLine = beforeCursor.slice(beforeCursor.lastIndexOf("\n") + 1);
  const indent = leadingWhitespace(currentLine);

  // Nothing to carry, so let the default newline handle it and keep this path
  // out of the undo history.
  if (indent.length === 0) return false;

  if (dispatch) {
    const inserted = `\n${indent}`;
    const transaction = state.tr.insertText(inserted, from, to);
    const caret = from + inserted.length;
    transaction.setSelection(TextSelection.create(transaction.doc, caret));
    dispatch(transaction.scrollIntoView());
  }
  return true;
}

/**
 * Tab and Shift+Tab inside a fence. A collapsed cursor indents at the caret so
 * Tab works mid-line the way typing does; any selection spanning text indents
 * the whole lines it touches, which is what makes re-indenting a block possible.
 */
export function indentCodeBlock(
  state: EditorState,
  direction: "in" | "out",
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const block = codeBlockRange(state);
  if (!block) return false;

  const { from, to } = state.selection;
  const startOffset = from - block.from;
  const endOffset = to - block.from;

  if (from === to && direction === "in") {
    if (dispatch) {
      const transaction = state.tr.insertText(CODE_BLOCK_INDENT, from, to);
      dispatch(transaction.scrollIntoView());
    }
    return true;
  }

  // Grow the range to whole lines so indenting is stable no matter where in the
  // first and last lines the selection happens to start and end.
  const lineStart = block.text.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
  const newlineAfter = block.text.indexOf("\n", endOffset);
  const lineEnd = newlineAfter === -1 ? block.text.length : newlineAfter;

  const originalLines = block.text.slice(lineStart, lineEnd).split("\n");
  const nextLines = indentLines(originalLines, direction);
  if (nextLines.join("\n") === originalLines.join("\n")) return true;

  if (dispatch) {
    const transaction = state.tr.insertText(
      nextLines.join("\n"),
      block.from + lineStart,
      block.from + lineEnd,
    );
    // Keep the same lines selected after the shift, so repeated Tab presses
    // keep indenting the block rather than collapsing the selection.
    // `split` always yields at least one entry, so these stand in only for the
    // compiler's benefit.
    const firstDelta = (nextLines[0]?.length ?? 0) - (originalLines[0]?.length ?? 0);
    const totalDelta = nextLines.join("\n").length - originalLines.join("\n").length;
    const nextFrom = Math.max(block.from + lineStart, from + firstDelta);
    const nextTo = Math.max(nextFrom, to + totalDelta);
    transaction.setSelection(TextSelection.create(transaction.doc, nextFrom, nextTo));
    dispatch(transaction.scrollIntoView());
  }
  return true;
}

/**
 * Enter on a line that is nothing but an opening fence turns it into a code
 * block. Tiptap's own input rules only fire on a space, so without this the
 * gesture every markdown editor has — ```` ```ts ```` then Enter — leaves the
 * fence as literal text.
 */
export function convertCodeFenceOnEnter(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const { $from, empty } = state.selection;
  // Top-level paragraphs only: the list and quote serializers have no line
  // to write a fence into, so one created inside them would vanish.
  if (!empty || $from.parent.type.name !== "paragraph" || $from.depth !== 1) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const match = /^(`{3,}|~{3,})([A-Za-z0-9_+#.-]*)$/.exec($from.parent.textContent);
  const codeBlock = state.schema.nodes.codeBlock;
  if (!match || !codeBlock) return false;

  if (dispatch) {
    const blockStart = $from.before();
    const fence = match[1]!;
    const transaction = state.tr.replaceWith(
      blockStart,
      blockStart + $from.parent.nodeSize,
      codeBlock.create({ language: match[2] ?? "", fence, close: `\n${fence}` }),
    );
    transaction.setSelection(TextSelection.create(transaction.doc, blockStart + 1));
    dispatch(transaction.scrollIntoView());
  }
  return true;
}

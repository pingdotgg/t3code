import { cutLineNoteStart } from "@t3tools/shared/diffCutLines";

const HIGHLIGHT_NAME = "t3-cut-line-note";

/**
 * Goes in the diff's shadow root, where the highlighted text lives. A file with cut lines cannot
 * load the unchanged lines around them, so it drops the controls that would.
 */
export const CUT_LINES_CSS = `
::highlight(${HIGHLIGHT_NAME}) {
  color: var(--color-warning-foreground);
  background-color: color-mix(in srgb, var(--color-warning) 18%, transparent);
}
:host([data-cut-lines]) :is([data-expand-button], [data-expand-all-button]) {
  display: none;
}`;

let highlight: Highlight | null = null;

/**
 * Styles cut-line notes so they do not read as code. Lines this long render untokenized, one
 * text node each, so a range highlight is the only way to reach the note without the code.
 */
export function markCutLineNotes(fileContainer: HTMLElement): void {
  const root = fileContainer.shadowRoot;
  if (root === null || typeof Highlight === "undefined" || !CSS.highlights) return;
  if (highlight === null) {
    highlight = new Highlight();
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
  }
  const marked = new Set<Node>();
  // A range over a removed row collapses onto the row's parent rather than disconnecting.
  for (const range of highlight) {
    if (range.collapsed || !range.startContainer.isConnected) highlight.delete(range);
    else marked.add(range.startContainer);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    if (marked.has(text)) continue;
    const value = text.nodeValue ?? "";
    const noteStart = cutLineNoteStart(value);
    if (noteStart === null) continue;
    const range = new Range();
    range.setStart(text, noteStart);
    range.setEnd(text, value.length);
    highlight.add(range);
    marked.add(text);
  }
}

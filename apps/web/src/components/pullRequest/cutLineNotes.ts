// The note the server appends to a withheld file's line it cut short.
const CUT_LINE_NOTE = / …\[[\d,]+ more characters\]$/;
const HIGHLIGHT_NAME = "t3-cut-line-note";

export function hasCutLineNotes(patch: string): boolean {
  return new RegExp(CUT_LINE_NOTE.source, "m").test(patch);
}

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
    const value = text.nodeValue ?? "";
    if (marked.has(text) || !value.endsWith("more characters]")) continue;
    const note = CUT_LINE_NOTE.exec(value);
    if (note === null) continue;
    const range = new Range();
    range.setStart(text, note.index + 1);
    range.setEnd(text, value.length);
    highlight.add(range);
    marked.add(text);
  }
}

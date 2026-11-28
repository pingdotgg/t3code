// Callers pass the start of an item remark-gfm parsed as a task, so this only locates the marker:
// after the bullet, or on the next line (past any blockquote prefix) when the bullet stands alone.
const taskMarker =
  /[ \t]*(?:[-+*]|\d+[.)])(?:[ \t]+|[ \t]*(?:\r\n?|\n)(?:[ \t]*>)*[ \t]*)\[[ xX]\]/y;

/** Offset of the `[ ]` marker of the task list item starting at `listItemStart`. */
export function taskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  taskMarker.lastIndex = listItemStart;
  return taskMarker.exec(markdown) ? taskMarker.lastIndex - 3 : null;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}

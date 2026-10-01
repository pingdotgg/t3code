/**
 * Toggles a Markdown task-list marker (`[ ]` <-> `[x]`) at a byte offset.
 * Ported from upstream `filePreviewMode.ts`; the offset comes from the
 * rendered checkbox's `data-task-marker-offset` (see `ChatMarkdown`).
 */
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

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

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

export function resolveMarkdownTaskPreviewUpdate(input: {
  readonly markdown: string;
  readonly markerOffset: number;
  readonly checked: boolean;
  readonly truncated: boolean;
}): string | null {
  if (input.truncated) return null;
  const nextMarkdown = setMarkdownTaskChecked(input.markdown, input.markerOffset, input.checked);
  return nextMarkdown === input.markdown ? null : nextMarkdown;
}

import type { MarkdownHighlightedToken } from "./SelectableMarkdownText.types";

/** Keep finished lines colored while the current line awaits highlighting. */
export function pendingCodeHighlight(
  previousCode: string,
  code: string,
  tokens: ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>>,
): ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>> | null {
  const end = previousCode.lastIndexOf("\n") + 1;
  if (!end || !code.startsWith(previousCode.slice(0, end))) return null;
  const completedLines = previousCode.slice(0, end).split("\n").length - 1;
  return [
    ...tokens.slice(0, completedLines),
    ...code
      .slice(end)
      .split("\n")
      .map((content) => [{ content, color: null, fontStyle: null }]),
  ];
}

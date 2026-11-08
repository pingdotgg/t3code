// Custom build: a reply's `options` block shows as next-message buttons above the composer, so
// the reply itself hides it, like the desktop app does.

// Same rule as the server's parseReplyOptions (packages/provider-core/src/server/
// nextPromptSuggestions.ts): any spaces or tabs before the fence (so a block indented inside a
// list counts), and CRLF line endings.
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*?)\r?$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/;

// The info string is exactly `options` (trailing spaces allowed), so a block is hidden only when
// it also becomes buttons.
function isOptionsInfo(info: string): boolean {
  return /^options[ \t]*$/.test(info);
}

function closesFence(line: string, marker: string, exact: boolean): boolean {
  const match = FENCE_CLOSE.exec(line);
  if (match === null || match[1] === undefined) return false;
  // The server closes an `options` block only with the same marker; other fences follow
  // CommonMark (same character, at least as long).
  return exact
    ? match[1] === marker
    : match[1][0] === marker[0] && match[1].length >= marker.length;
}

/**
 * Removes every fenced code block whose language is `options`. Other fences stay as written,
 * including an `options` fence quoted inside one of them. An unclosed `options` fence (a reply
 * still streaming) is removed through the end.
 */
export function stripOptionsCodeFences(markdown: string): string {
  if (!/options/i.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let openMarker: string | null = null;
  let hiding = false;
  let removed = false;
  for (const line of lines) {
    if (openMarker !== null) {
      if (closesFence(line, openMarker, hiding)) {
        openMarker = null;
        if (hiding) {
          hiding = false;
          continue;
        }
      }
      if (!hiding) kept.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null && open[1] !== undefined) {
      const marker = open[1];
      const info = open[2] ?? "";
      // A backtick fence's info string cannot contain backticks.
      if (!(marker[0] === "`" && info.includes("`"))) {
        openMarker = marker;
        hiding = isOptionsInfo(info);
        if (hiding) {
          removed = true;
          continue;
        }
      }
    }
    kept.push(line);
  }
  if (!removed) return markdown;
  return kept.join("\n").trimEnd();
}

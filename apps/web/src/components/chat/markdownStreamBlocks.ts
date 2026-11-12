// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
// Claude insight fences render as one callout, so they stay in one block until the closing rule.
const INSIGHT_OPEN_PATTERN = /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u;
const INSIGHT_CLOSE_PATTERN = /^( {0,3})(`?)─{3,}\2[ \t]*$/u;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(text)) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  let insightIndent: string | null = null;
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) break;
      if (
        opener &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      ) {
        fence = null;
      }
    } else if (insightIndent !== null && INSIGHT_CLOSE_PATTERN.exec(line)?.[1] === insightIndent) {
      insightIndent = null;
      afterBlankLine = false;
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      if (
        afterBlankLine &&
        insightIndent === null &&
        lineStart > blockStart &&
        !CONTINUATION_PATTERN.test(line)
      ) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      if (insightIndent === null) insightIndent = INSIGHT_OPEN_PATTERN.exec(line)?.[1] ?? null;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

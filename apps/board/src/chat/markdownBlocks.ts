// Definitions (footnote ones too), raw HTML, container directives and display math can tie blocks
// together. A line inside a fence is code, so `[^a-z]` or `<T>` there ties nothing.
const DOCUMENT_WIDE_LINE = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)/;
// A backtick fence's info string cannot contain a backtick, so "```a``` is inline" is a code span.
const FENCE_PATTERN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts a reply at the blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks, such as
 * link definitions, which only the whole text can resolve.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.startsWith("\ufeff") || text.includes("\r")) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) {
        if (
          text
            .slice(lineStart)
            .split("\n")
            .some((rest) => DOCUMENT_WIDE_LINE.test(rest))
        ) {
          return null;
        }
        break;
      }
      if (
        opener &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      ) {
        fence = null;
      }
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      if (DOCUMENT_WIDE_LINE.test(line)) return null;
      if (afterBlankLine && lineStart > blockStart && !CONTINUATION_PATTERN.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

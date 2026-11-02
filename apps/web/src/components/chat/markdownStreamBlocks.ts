// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes("\r") || text.includes("\uFEFF")) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  for (const line of text.split("\n")) {
    if (fence === null && DOCUMENT_WIDE_SYNTAX.test(line)) return null;
    const match = FENCE_PATTERN.exec(line);
    const opener =
      match && !(match[1]![0] === "`" && line.slice(match[0].length).includes("`"))
        ? match[1]
        : undefined;
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
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
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

/** Keeps closed blocks while rescanning the open tail of an append-only reply. */
export function createMarkdownBlockSplitter() {
  let previous = "";
  let offset = 0;
  let closed: string[] = [];
  let documentWide = false;
  return (text: string): string[] | null => {
    if (!text.startsWith(previous)) {
      offset = 0;
      closed = [];
      documentWide = false;
    }
    previous = text;
    if (documentWide) return null;
    const tail = splitMarkdownBlocks(text.slice(offset));
    if (tail === null) {
      documentWide = true;
      return null;
    }
    // A partial first line can still turn into a list continuation, joining the prior block.
    const finished = tail.slice(0, -2);
    closed = closed.concat(finished);
    for (const block of finished) offset += block.length;
    return closed.concat(tail.slice(-2));
  };
}

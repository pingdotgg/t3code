import { githubHeadingSlug } from "./markdownFragments";

// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
// A backtick fence's info string cannot contain a backtick, so "```a``` is inline" is a code span.
const FENCE_PATTERN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
// Claude insight fences render as one callout, so they stay in one block until the closing rule.
const INSIGHT_OPEN_PATTERN = /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u;
const INSIGHT_CLOSE_PATTERN = /^( {0,3})(`?)─{3,}\2[ \t]*$/u;
// An ATX heading, also inside a list item or blockquote; group 1 is its text.
const ATX_HEADING_PATTERN =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
// Setext headings may span a paragraph and containers, so leave their parsing to the renderer.
const SETEXT_UNDERLINE_PATTERN =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*(?:=+|-+)[ \t]*$/;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks, such as
 * headings with the same slug, whose ids are numbered across the whole text.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  // remark-parse strips a leading BOM before recognizing the first heading.
  if (text.startsWith("\ufeff") || text.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(text))
    return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  let insightIndent: string | null = null;
  const headingKeys = new Set<string>();
  const needsWholeHeading = (headingText: string | undefined) => {
    if (headingText === undefined) return false;
    // Inline syntax and path/directive colons need the renderer before their slug is known.
    if (/[`*_~[\]<&\\!$]|:(?!\s|$)/.test(headingText)) return true;
    const key = githubHeadingSlug(headingText);
    if (!key) return false;
    if (headingKeys.has(key)) return true;
    headingKeys.add(key);
    return false;
  };
  const headingNeedsWholeDocument = (line: string, mayUnderline = true) =>
    (mayUnderline && SETEXT_UNDERLINE_PATTERN.test(line)) ||
    needsWholeHeading(ATX_HEADING_PATTERN.exec(line)?.[1]);
  // Only a line right after paragraph text can underline it; elsewhere "---" is a thematic break.
  let afterContentLine = false;
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    const mayUnderline = afterContentLine;
    afterContentLine = false;
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) {
        const rest = text.slice(lineStart).split("\n");
        for (const restLine of rest) {
          if (headingNeedsWholeDocument(restLine)) return null;
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
    } else if (insightIndent !== null && INSIGHT_CLOSE_PATTERN.exec(line)?.[1] === insightIndent) {
      insightIndent = null;
      afterBlankLine = false;
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      if (headingNeedsWholeDocument(line, mayUnderline)) return null;
      afterContentLine = opener === undefined;
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

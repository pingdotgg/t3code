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
const SETEXT_UNDERLINE_PATTERN = /^ {0,3}(?:=+|-+)[ \t]*$/;

/**
 * Approximates the slug `rehypeHeadingIds` derives from a heading's rendered text. It drops
 * images, link destinations and underscores, so it may match where the real slugs differ, never
 * the other way round for the syntax this splitter lets through.
 */
function headingKey(text: string): string {
  return githubHeadingSlug(
    text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\]\([^)]*\)/g, "]"),
  ).replaceAll("_", "");
}

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks, such as
 * headings with the same slug, whose ids are numbered across the whole text.
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
  let previousLine = "";
  const headingKeys = new Set<string>();
  const repeatsHeading = (headingText: string | undefined) => {
    const key = headingText === undefined ? "" : headingKey(headingText);
    if (!key) return false;
    if (headingKeys.has(key)) return true;
    headingKeys.add(key);
    return false;
  };
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) {
        const rest = text.slice(lineStart).split("\n");
        if (rest.some((restLine) => repeatsHeading(ATX_HEADING_PATTERN.exec(restLine)?.[1]))) {
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
    } else if (insightIndent !== null && INSIGHT_CLOSE_PATTERN.exec(line)?.[1] === insightIndent) {
      insightIndent = null;
      afterBlankLine = false;
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      const headingText = SETEXT_UNDERLINE_PATTERN.test(line)
        ? afterBlankLine
          ? undefined
          : previousLine
        : ATX_HEADING_PATTERN.exec(line)?.[1];
      if (repeatsHeading(headingText)) return null;
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
    previousLine = line;
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

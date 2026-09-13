/**
 * Detects markdown that the renderer draws as a block requiring a definite
 * user-bubble width: fenced and indented code blocks, GFM tables, ordered
 * lists, and blockquotes when requested by the caller.
 *
 * Fenced code blocks and tables report an intrinsic width equal to their
 * widest line, which is effectively unbounded. A user bubble sizes itself
 * from its content
 * (`maxWidth` with no `width`), so Android lays the bubble's children out
 * during the unclamped intrinsic pass — where the surrounding paragraphs
 * collapse to a single line — and never repositions them once the width is
 * clamped back to `maxWidth`. The result is siblings drawn on top of each
 * other inside an over-tall bubble. Pinning the bubble's width removes the
 * intrinsic pass entirely, which is the same reason review-comment bubbles
 * already carry an explicit width.
 *
 * Ordered lists hit the same Android layout bug because each item contains a
 * flexing content column inside a shrink-to-fit row.
 *
 * A four-space ordered marker is only treated as a list when the preceding
 * non-empty line is a less-indented list item. This keeps standalone indented
 * code out of the heuristic while covering nested lists.
 */

const FENCED_CODE_BLOCK = /^ {0,3}(?:```|~~~)/m;
// Trades some precision for a simple check, favoring false positives over false
// negatives: list-shaped paragraph may get a wider bubble
const ORDERED_LIST_ITEM = /^ {0,3}\d{1,9}[.)](?:[ \t]+|$)/;
const INDENTED_ORDERED_LIST_ITEM = /^( {4,})\d{1,9}[.)](?:[ \t]+|$)/;
const ANY_LIST_ITEM = /^( *)(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const BLOCKQUOTE_PREFIX = /^ {0,3}>[ \t]?/;

export interface WideMarkdownBlockOptions {
  readonly includeOrderedLists?: boolean;
  readonly includeBlockquotes?: boolean;
}

function stripBlockquotePrefixes(line: string): string {
  let content = line;
  while (BLOCKQUOTE_PREFIX.test(content)) {
    content = content.replace(BLOCKQUOTE_PREFIX, "");
  }
  return content;
}

function hasIndentedCodeBlock(text: string): boolean {
  return text.split("\n").some((rawLine) => {
    const line = stripBlockquotePrefixes(rawLine);
    let column = 0;
    let index = 0;

    // Markdown tabs advance to the next four-column stop.
    while (index < line.length) {
      if (line[index] === " ") {
        column += 1;
      } else if (line[index] === "\t") {
        column += 4 - (column % 4);
      } else {
        break;
      }
      index += 1;
    }

    return column >= 4 && index < line.length && line[index] !== "\r";
  });
}

function hasBlockquote(text: string): boolean {
  return text.split("\n").some((line) => BLOCKQUOTE_PREFIX.test(line));
}

function hasOrderedListItem(text: string): boolean {
  let previousNonEmptyLine: string | null = null;

  for (const rawLine of text.split("\n")) {
    const line = stripBlockquotePrefixes(rawLine);
    if (ORDERED_LIST_ITEM.test(line)) {
      return true;
    }

    const nestedMatch = INDENTED_ORDERED_LIST_ITEM.exec(line);
    const parentMatch =
      previousNonEmptyLine === null ? null : ANY_LIST_ITEM.exec(previousNonEmptyLine);
    if (nestedMatch && parentMatch && parentMatch[1].length < nestedMatch[1].length) {
      return true;
    }

    if (line.trim().length > 0) {
      previousNonEmptyLine = line;
    }
  }

  return false;
}

function isTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) {
    return false;
  }
  return /^[|\-: \t]+$/.test(trimmed);
}

export function hasWideMarkdownBlock(
  text: string,
  options: WideMarkdownBlockOptions = {},
): boolean {
  if (FENCED_CODE_BLOCK.test(text)) {
    return true;
  }
  if (options.includeBlockquotes === true && hasBlockquote(text)) {
    return true;
  }
  if (hasIndentedCodeBlock(text)) {
    return true;
  }
  if (options.includeOrderedLists !== false && hasOrderedListItem(text)) {
    return true;
  }
  if (!text.includes("|")) {
    return false;
  }
  return text.split("\n").some(isTableDelimiterRow);
}

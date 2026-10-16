/**
 * A user bubble sizes itself from its content (`maxWidth` with no `width`), so
 * Android lays the bubble's children out during the unclamped intrinsic pass —
 * where the surrounding paragraphs collapse to a single line — and never
 * repositions them once the width is clamped back to `maxWidth`. Ordered lists
 * hit the same Android layout bug because each item contains a flexing content
 * column inside a shrink-to-fit row.
 */

const FENCED_CODE_BLOCK = /^ {0,3}(?:```|~~~)/m;
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
    if (
      nestedMatch?.[1] !== undefined &&
      parentMatch?.[1] !== undefined &&
      parentMatch[1].length < nestedMatch[1].length
    ) {
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

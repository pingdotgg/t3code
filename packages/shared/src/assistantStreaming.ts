/** Shared with turn playback so paragraph boundaries match server streaming. */
// List fences can open at any indentation; closers may be at most three spaces deeper.
// A backtick fence's info string cannot contain a backtick, so "```npm test``` runs" is inline code.
const MARKDOWN_FENCE_PATTERN = /^([ \t]*)(`{3,}(?![^`\r\n]*`)|~{3,})/;
const LIST_MARKER_PATTERN = /[-*+]|\d{1,9}[.)]/y;
// CommonMark blank lines contain only spaces and tabs.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// Require trailing space so partial list markers cannot match during streaming.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// Unindented ATX headings end preceding paragraphs and lists without blank lines; bold lines do not.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

// Matches LIST_ITEM_START_PATTERN on the trimmed partial line without copying it.
const PARTIAL_LIST_ITEM_START_PATTERN = /[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t][ \t\r]*[^ \t\r]/y;

export interface AssistantTextScan {
  readonly text: string;
  // Start of the partial line; every line before it has been scanned.
  readonly lineStart: number;
  readonly openFence: {
    readonly marker: string;
    readonly indent: number;
    // A fence opened on a list item line ends with the item, at a line indented less than this.
    readonly minIndent: number;
  } | null;
  readonly boundary: number;
  readonly titleAwaitingContent: boolean;
}

export const EMPTY_SCAN: AssistantTextScan = {
  text: "",
  lineStart: 0,
  openFence: null,
  boundary: -1,
  titleAwaitingContent: false,
};

function trimLineEnd(text: string, start: number, end: number): string {
  while (end > start) {
    const char = text.charCodeAt(end - 1);
    if (char !== 32 && char !== 9 && char !== 13) break;
    end--;
  }
  return text.slice(start, end);
}

// Skips spaces and tabs from `i`, counting columns with CommonMark's 4-column tab stops.
function skipIndent(line: string, i: number, col: number): { i: number; col: number } {
  for (; i < line.length; i++) {
    const char = line.charCodeAt(i);
    if (char === 32) col++;
    else if (char === 9) col += 4 - (col % 4);
    else break;
  }
  return { i, col };
}

const leadingIndent = (line: string) => skipIndent(line, 0, 0).col;

// A fence opened after list markers ("- ```", "1. - ~~~"); `indent` is its content column.
function matchListItemFence(line: string): { marker: string; indent: number } | null {
  let { i, col } = skipIndent(line, 0, 0);
  let matched = false;
  for (;;) {
    LIST_MARKER_PATTERN.lastIndex = i;
    const listMarker = LIST_MARKER_PATTERN.exec(line);
    if (!listMarker) break;
    const afterMarker = col + listMarker[0].length;
    ({ i, col } = skipIndent(line, i + listMarker[0].length, afterMarker));
    if (col === afterMarker || col - afterMarker > 4) return null;
    matched = true;
  }
  if (!matched) return null;
  const fence = MARKDOWN_FENCE_PATTERN.exec(line.slice(i));
  return fence ? { marker: fence[2]!, indent: col } : null;
}

/** Scans the terminated lines of `text`, resuming after `previous` when `text` extends it. */
export function advanceScan(previous: AssistantTextScan, text: string): AssistantTextScan {
  const resumed = text.startsWith(previous.text);
  let { openFence, boundary, lineStart, titleAwaitingContent } = resumed ? previous : EMPTY_SCAN;
  let searchFrom = resumed ? previous.text.length : 0;
  if (resumed && text.charCodeAt(searchFrom - 1) === 13 && text.charCodeAt(searchFrom) === 10) {
    if (boundary === lineStart) boundary++;
    lineStart = ++searchFrom;
  }
  let nextLf = text.indexOf("\n", searchFrom);
  let nextCr = text.indexOf("\r", searchFrom);
  for (;;) {
    let newline = nextLf === -1 ? nextCr : nextCr === -1 || nextLf < nextCr ? nextLf : nextCr;
    if (newline === -1) break;
    const line = trimLineEnd(text, lineStart, newline);
    if (text.charCodeAt(newline) === 13 && text.charCodeAt(newline + 1) === 10) newline++;
    if (
      openFence !== null &&
      openFence.minIndent > 0 &&
      line.length > 0 &&
      leadingIndent(line) < openFence.minIndent
    ) {
      openFence = null;
    }
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = lineStart;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    const listFenceMatch = openFence === null && !fenceMatch ? matchListItemFence(line) : null;
    if (fenceMatch) {
      const prefix = fenceMatch[1]!;
      const indent = leadingIndent(prefix);
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent, minIndent: 0 };
        titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === prefix.length + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (listFenceMatch) {
      openFence = {
        marker: listFenceMatch.marker,
        indent: listFenceMatch.indent,
        minIndent: listFenceMatch.indent,
      };
      titleAwaitingContent = false;
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        boundary = newline + 1;
      }
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        boundary = lineStart;
      }
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    lineStart = newline + 1;
    searchFrom = lineStart;
    if (nextLf !== -1 && nextLf < searchFrom) nextLf = text.indexOf("\n", searchFrom);
    if (nextCr !== -1 && nextCr < searchFrom) nextCr = text.indexOf("\r", searchFrom);
  }
  return { text, lineStart, openFence, boundary, titleAwaitingContent };
}

// The partial line may still change, so its list item start is checked here, not kept in the scan.
export function readyBoundary(scan: AssistantTextScan): number {
  if (scan.openFence === null && scan.lineStart > 0 && !scan.titleAwaitingContent) {
    PARTIAL_LIST_ITEM_START_PATTERN.lastIndex = scan.lineStart;
    if (PARTIAL_LIST_ITEM_START_PATTERN.test(scan.text)) return scan.lineStart;
  }
  return scan.boundary;
}

/** Emit terminated lines only, except partial list-start lookahead for tight lists. Hold section titles until content follows. */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  const boundary = readyBoundary(advanceScan(EMPTY_SCAN, text));
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

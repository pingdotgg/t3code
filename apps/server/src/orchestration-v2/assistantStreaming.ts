import type { ResponseStreamingMode } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

// An opening fence may sit at any indentation, since fences inside list items
// are indented past the marker. A closing fence may be indented at most three
// spaces more than its opener.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// The trailing space is required, so a partial `-` or `1.` never matches before
// the model finishes the marker.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// An unindented ATX heading ends the paragraph or list above it, even with no
// blank line between them. A bold line would continue the paragraph instead.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

// Sticky helpers that inspect a streaming partial line in place, so a line that
// grows without a newline is never copied or rescanned from its start.
const INDENT_PATTERN = /[ \t]*/y;
const LIST_MARKER_PATTERN = /(?:[-*+]|\d{1,9}[.)])[ \t]/y;
const TRAILING_SPACE_PATTERN = /[ \t\r]*/y;

interface AssistantTextScan {
  text: string;
  lineStart: number;
  newlineSearchFrom: number;
  openFence: { marker: string; indent: number } | null;
  boundary: number;
  titleAwaitingContent: boolean;
  partialIndentEnd: number;
  partialContentSearchFrom: number;
}

function startScan(): AssistantTextScan {
  return {
    text: "",
    lineStart: 0,
    newlineSearchFrom: 0,
    openFence: null,
    boundary: -1,
    titleAwaitingContent: false,
    partialIndentEnd: 0,
    partialContentSearchFrom: 0,
  };
}

function trimLineEnd(text: string, start: number, end: number): string {
  while (end > start) {
    const char = text.charCodeAt(end - 1);
    if (char !== 32 && char !== 9 && char !== 13) break;
    end--;
  }
  return text.slice(start, end);
}

function stickyMatchEnd(pattern: RegExp, text: string, from: number): number {
  pattern.lastIndex = from;
  return pattern.exec(text) === null ? -1 : pattern.lastIndex;
}

// Matches LIST_ITEM_START_PATTERN against the trimmed partial line. Every
// search resumes where the previous call on this line stopped.
function partialLineStartsListItem(scan: AssistantTextScan, text: string): boolean {
  scan.partialIndentEnd = stickyMatchEnd(INDENT_PATTERN, text, scan.partialIndentEnd);
  const markerEnd = stickyMatchEnd(LIST_MARKER_PATTERN, text, scan.partialIndentEnd);
  if (markerEnd === -1) return false;
  // Trimming would drop the marker's trailing space unless content follows it.
  scan.partialContentSearchFrom = stickyMatchEnd(
    TRAILING_SPACE_PATTERN,
    text,
    Math.max(markerEnd, scan.partialContentSearchFrom),
  );
  return scan.partialContentSearchFrom < text.length;
}

/**
 * Only fully terminated lines count, so a trailing partial line never leaks; a
 * list item start is the one lookahead that may sit on the partial line, since
 * tight lists have no blank lines between items and would otherwise land all at
 * once.
 *
 * A section title holds the boundary until a content line follows it, so a
 * title never lands alone and waits above a block that is still streaming.
 *
 * Text that extends the previously scanned text resumes from its last partial
 * line, so a streamed reply is scanned once rather than once per update.
 */
function advanceScan(previous: AssistantTextScan, text: string): AssistantTextScan {
  const scan = text.startsWith(previous.text) ? { ...previous } : startScan();
  scan.text = text;
  for (;;) {
    const lineStart = scan.lineStart;
    const newline = text.indexOf("\n", scan.newlineSearchFrom);
    if (newline === -1) {
      scan.newlineSearchFrom = text.length;
      break;
    }
    const line = trimLineEnd(text, lineStart, newline);
    const { openFence, titleAwaitingContent } = scan;
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      scan.boundary = lineStart;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        scan.openFence = { marker, indent };
        scan.titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        scan.openFence = null;
        scan.boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        scan.boundary = newline + 1;
      }
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        scan.boundary = lineStart;
      }
      scan.titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    scan.lineStart = newline + 1;
    scan.newlineSearchFrom = newline + 1;
    scan.partialIndentEnd = newline + 1;
    scan.partialContentSearchFrom = newline + 1;
  }
  return scan;
}

// The partial line's list item start is not kept in the scan, because the
// line may still be replaced before it ends.
function readyBoundary(scan: AssistantTextScan): number {
  if (
    scan.openFence === null &&
    scan.lineStart > 0 &&
    !scan.titleAwaitingContent &&
    partialLineStartsListItem(scan, scan.text)
  ) {
    return scan.lineStart;
  }
  return scan.boundary;
}

export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  const boundary = readyBoundary(advanceScan(startScan(), text));
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

export function makeAssistantStreamingFilter(mode: ResponseStreamingMode) {
  const streams = new Map<
    string,
    { scan: AssistantTextScan; delivered: { text: string; at: number } | null }
  >();
  return (
    event: ProviderAdapter.ProviderAdapterV2Event,
    now: number,
  ): ProviderAdapter.ProviderAdapterV2Event | null => {
    if (
      event.type === "node.updated" &&
      event.node.kind === "assistant_message" &&
      event.node.status === "running"
    )
      return null;
    const message =
      event.type === "message.updated" && event.message.role === "assistant"
        ? event.message
        : event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
          ? event.turnItem
          : null;
    if (!message) return event;
    const key = `${event.type}:${message.id}`;
    if (!message.streaming) {
      streams.delete(key);
      return event;
    }
    if (mode === "turn") return null;
    const stream = streams.get(key);
    const previous = stream?.delivered ?? null;
    if (previous && now - previous.at < 400) return null;
    const scan = advanceScan(stream?.scan ?? startScan(), message.text);
    const boundary = readyBoundary(scan);
    const ready = boundary === -1 ? "" : message.text.slice(0, boundary);
    if (!ready || ready === previous?.text) {
      streams.set(key, { scan, delivered: previous });
      return null;
    }
    streams.set(key, { scan, delivered: { text: ready, at: now } });
    if (event.type === "message.updated")
      return { ...event, message: { ...event.message, text: ready } };
    if (
      event.type === "turn_item.updated" &&
      (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
    )
      return { ...event, turnItem: { ...event.turnItem, text: ready } };
    return event;
  };
}

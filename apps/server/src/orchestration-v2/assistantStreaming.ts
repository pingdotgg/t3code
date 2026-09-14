import type { ResponseStreamingMode } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

// An opening fence may sit at any indentation, since fences inside list
// items are indented past the marker. A closing fence may be indented at most
// three spaces more than its opener. Deeper lines are content in the block.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;

/**
 * Splits buffered assistant text at the last blank line or closing code fence
 * that is not inside an open fenced code block. `ready` is safe to deliver now
 * because the markdown before it will not change shape as more text arrives.
 * `rest` stays buffered until the next boundary or completion. Only fully
 * terminated lines count, so a trailing partial line never leaks.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = -1;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) {
      break;
    }
    const line = text.slice(lineStart, newline).replace(/[ \t\r]+$/, "");
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      boundary = newline + 1;
    }
    lineStart = newline + 1;
  }
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

/** Each adapter publishes cumulative text. Keep unfinished markdown out of the read model. */
export function makeAssistantStreamingFilter(mode: ResponseStreamingMode) {
  const delivered = new Map<string, { text: string; at: number }>();
  return (event: ProviderAdapterV2Event, now: number): ProviderAdapterV2Event | null => {
    if (mode === "token") return event;
    if (
      event.type === "node.updated" &&
      event.node.kind === "assistant_message" &&
      event.node.status === "running"
    )
      return null;
    const message =
      event.type === "message.updated" && event.message.role === "assistant"
        ? event.message
        : event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? event.turnItem
          : null;
    if (!message) return event;
    const key = `${event.type}:${message.id}`;
    if (!message.streaming) {
      delivered.delete(key);
      return event;
    }
    if (mode === "turn") return null;
    const previous = delivered.get(key);
    if (previous && now - previous.at < 400) return null;
    const { ready } = splitBufferedAssistantText(message.text);
    if (!ready || ready === previous?.text) return null;
    delivered.set(key, { text: ready, at: now });
    if (event.type === "message.updated")
      return { ...event, message: { ...event.message, text: ready } };
    if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message")
      return { ...event, turnItem: { ...event.turnItem, text: ready } };
    return event;
  };
}

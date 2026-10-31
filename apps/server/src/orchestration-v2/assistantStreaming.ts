import type { ResponseStreamingMode } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

// List fences can open at any indentation; closers may be at most three spaces deeper.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines contain only spaces and tabs.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// Require trailing space so partial list markers cannot match during streaming.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// Unindented ATX headings end preceding paragraphs and lists without blank lines; bold lines do not.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

/** Emit terminated lines only, except partial list-start lookahead for tight lists. Hold section titles until content follows. */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = -1;
  let lineStart = 0;
  let titleAwaitingContent = false;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const line = text
      .slice(lineStart, newline === -1 ? text.length : newline)
      .replace(/[ \t\r]+$/, "");
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = lineStart;
    }
    if (newline === -1) {
      break;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
        titleAwaitingContent = false;
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
  }
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

// Long enough to ride out normal gaps between chunks; short enough that text written before a
// long tool call or background wait does not look lost.
const ASSISTANT_IDLE_FLUSH_MS = 800;

type StreamedMessage = {
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
};

interface StreamTrack {
  readonly text: string;
  readonly at: number;
  // Latest snapshot whose text has not all been delivered yet.
  readonly held: ProviderAdapter.ProviderAdapterV2Event | null;
  readonly dueAt: number;
}

/** A held snapshot due for delivery. Each outcome applies only while nothing newer replaced it. */
interface IdleFlush {
  readonly event: ProviderAdapter.ProviderAdapterV2Event;
  readonly delivered: (now: number) => void;
  readonly retryAt: (at: number) => void;
  readonly discard: () => void;
}

function streamedMessage(event: ProviderAdapter.ProviderAdapterV2Event): StreamedMessage | null {
  if (event.type === "message.updated" && event.message.role === "assistant") return event.message;
  if (
    event.type === "turn_item.updated" &&
    (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
  )
    return event.turnItem;
  return null;
}

function withText(
  event: ProviderAdapter.ProviderAdapterV2Event,
  text: string,
): ProviderAdapter.ProviderAdapterV2Event {
  if (event.type === "message.updated") return { ...event, message: { ...event.message, text } };
  if (
    event.type === "turn_item.updated" &&
    (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
  )
    return { ...event, turnItem: { ...event.turnItem, text } };
  return event;
}

/**
 * Paragraph mode delivers streamed text at Markdown boundaries, at most every 400ms. A snapshot
 * held back that way is delivered whole once its message has been idle for `idleFlushMs`, so a
 * provider that pauses mid-turn still shows everything it wrote.
 */
export function makeAssistantStreamingFilter(
  mode: ResponseStreamingMode,
  idleFlushMs = ASSISTANT_IDLE_FLUSH_MS,
) {
  const tracks = new Map<string, StreamTrack>();
  return {
    filter(
      event: ProviderAdapter.ProviderAdapterV2Event,
      now: number,
    ): ProviderAdapter.ProviderAdapterV2Event | null {
      if (
        event.type === "node.updated" &&
        event.node.kind === "assistant_message" &&
        event.node.status === "running"
      )
        return null;
      const message = streamedMessage(event);
      if (!message) return event;
      const key = `${event.type}:${message.id}`;
      if (!message.streaming) {
        tracks.delete(key);
        return event;
      }
      if (mode === "turn") return null;
      const previous = tracks.get(key);
      const delivered = previous?.text ?? "";
      const hold = () => {
        tracks.set(key, {
          text: delivered,
          at: previous?.at ?? Number.NEGATIVE_INFINITY,
          held: message.text !== delivered ? event : null,
          dueAt: now + idleFlushMs,
        });
        return null;
      };
      if (previous && now - previous.at < 400) return hold();
      const { ready } = splitBufferedAssistantText(message.text);
      // An idle delivery may already show more than the next boundary; never shrink it. A
      // provider rewrite or truncation is not a prefix and replaces it.
      if (delivered.startsWith(ready)) return hold();
      tracks.set(key, {
        text: ready,
        at: now,
        held: ready !== message.text ? event : null,
        dueAt: now + idleFlushMs,
      });
      return withText(event, ready);
    },
    nextIdleFlushAt(): number | null {
      let next: number | null = null;
      for (const track of tracks.values()) {
        if (track.held !== null && (next === null || track.dueAt < next)) next = track.dueAt;
      }
      return next;
    },
    dueIdleFlushes(now: number): ReadonlyArray<IdleFlush> {
      const due: Array<IdleFlush> = [];
      for (const [key, track] of tracks) {
        const event = track.held;
        if (event === null || track.dueAt > now) continue;
        const settle = (next: (current: StreamTrack) => StreamTrack) => {
          const current = tracks.get(key);
          if (current?.held === event) tracks.set(key, next(current));
        };
        due.push({
          event,
          delivered: (at) =>
            settle((current) => ({
              text: streamedMessage(event)?.text ?? current.text,
              at,
              held: null,
              dueAt: at,
            })),
          retryAt: (at) => settle((current) => ({ ...current, dueAt: at })),
          discard: () => settle((current) => ({ ...current, held: null })),
        });
      }
      return due;
    },
  };
}

import type { ResponseStreamingMode } from "@t3tools/contracts";
import {
  advanceScan,
  EMPTY_SCAN,
  readyBoundary,
  type AssistantTextScan,
} from "@t3tools/shared/assistantStreaming";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

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
  readonly scan: AssistantTextScan;
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
  // Earliest deadline of any held snapshot, or earlier: a newer snapshot only pushes its own
  // deadline later, so the cache stays O(1) per event and is recomputed when it comes due.
  let nextDueAt: number | null = null;
  const track = (key: string, value: StreamTrack) => {
    tracks.set(key, value);
    if (value.held !== null && (nextDueAt === null || value.dueAt < nextDueAt))
      nextDueAt = value.dueAt;
  };
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
      const hold = (scan = previous?.scan ?? EMPTY_SCAN) => {
        track(key, {
          text: delivered,
          at: previous?.at ?? Number.NEGATIVE_INFINITY,
          held: message.text !== delivered ? event : null,
          dueAt: now + idleFlushMs,
          scan,
        });
        return null;
      };
      if (previous && now - previous.at < 400) return hold();
      const scan = advanceScan(previous?.scan ?? EMPTY_SCAN, message.text);
      const boundary = readyBoundary(scan);
      const ready = boundary === -1 ? "" : message.text.slice(0, boundary);
      // An idle delivery may already show more than the next boundary; never shrink it. A
      // provider rewrite or truncation is not a prefix and replaces it.
      if (delivered.startsWith(ready)) return hold(scan);
      track(key, {
        text: ready,
        at: now,
        held: ready !== message.text ? event : null,
        dueAt: now + idleFlushMs,
        scan,
      });
      return withText(event, ready);
    },
    nextIdleFlushAt: (): number | null => nextDueAt,
    /** Returns the held snapshots due by `now` and counts them as delivered. */
    takeIdleFlushes(now: number): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> {
      const due: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      nextDueAt = null;
      for (const [key, current] of tracks) {
        const event = current.held;
        if (event === null) continue;
        if (current.dueAt > now) {
          if (nextDueAt === null || current.dueAt < nextDueAt) nextDueAt = current.dueAt;
          continue;
        }
        due.push(event);
        tracks.set(key, {
          text: streamedMessage(event)?.text ?? current.text,
          at: now,
          held: null,
          dueAt: now,
          scan: current.scan,
        });
      }
      return due;
    },
  };
}

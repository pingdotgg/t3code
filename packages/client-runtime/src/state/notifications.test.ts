import type { NotificationDecidedEdge } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  appendNotificationStreamItem,
  EMPTY_NOTIFICATION_EDGES,
  NOTIFICATION_EDGE_BUFFER_LIMIT,
} from "./notifications.ts";

function edge(sequence: number): NotificationDecidedEdge {
  return {
    identityKey: `t3:notif:thread-1:turn-completed:turn-${sequence}`,
    kind: "turn-completed",
    threadId: "thread-1",
    projectId: "project-1",
    turnId: `turn-${sequence}`,
    requestId: null,
    projectTitle: "t3",
    threadTitle: "Wire the toasts",
    headline: "Turn finished",
    detail: null,
    triggeringEventId: `event-${sequence}`,
    triggeringSequence: sequence,
    previousPhase: "running",
    nextPhase: "completed",
    detectedAt: "2026-08-06T10:00:00.000Z",
  } as unknown as NotificationDecidedEdge;
}

describe("appendNotificationStreamItem", () => {
  it("keeps a burst that lands in one render batch instead of only the last edge", () => {
    const [afterFirst, firstEmissions] = appendNotificationStreamItem(EMPTY_NOTIFICATION_EDGES, {
      kind: "edge",
      edge: edge(1),
    });
    const [afterSecond, secondEmissions] = appendNotificationStreamItem(afterFirst, {
      kind: "edge",
      edge: edge(2),
    });

    expect(firstEmissions).toEqual([[edge(1)]]);
    expect(secondEmissions).toEqual([[edge(1), edge(2)]]);
    expect(afterSecond.map((value) => value.triggeringSequence)).toEqual([1, 2]);
  });

  it("emits nothing for the synchronized marker and leaves the buffer alone", () => {
    const buffer = [edge(1)];
    expect(appendNotificationStreamItem(buffer, { kind: "synchronized" })).toEqual([buffer, []]);
  });

  it("drops the oldest edges past the buffer limit", () => {
    let buffer: ReadonlyArray<NotificationDecidedEdge> = EMPTY_NOTIFICATION_EDGES;
    for (let sequence = 1; sequence <= NOTIFICATION_EDGE_BUFFER_LIMIT + 3; sequence += 1) {
      [buffer] = appendNotificationStreamItem(buffer, { kind: "edge", edge: edge(sequence) });
    }

    expect(buffer).toHaveLength(NOTIFICATION_EDGE_BUFFER_LIMIT);
    expect(buffer[0]?.triggeringSequence).toBe(4);
    expect(buffer.at(-1)?.triggeringSequence).toBe(NOTIFICATION_EDGE_BUFFER_LIMIT + 3);
  });
});

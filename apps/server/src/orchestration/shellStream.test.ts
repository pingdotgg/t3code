import { CommandId, EventId, type OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { toShellStreamEvent } from "./shellStream.ts";

describe("toShellStreamEvent", () => {
  it("removes every archived nested thread without reading the active shell", async () => {
    let activeShellReads = 0;
    const query = {
      getProjectShellById: () => Effect.die("Archive events do not read projects"),
      getThreadShellById: () => {
        activeShellReads += 1;
        return Effect.die("Archive events do not read the active shell");
      },
    } satisfies Pick<ProjectionSnapshotQueryShape, "getProjectShellById" | "getThreadShellById">;
    const archiveEvent = (threadId: ThreadId, sequence: number) =>
      ({
        sequence,
        eventId: EventId.make(`event-thread-archived-${threadId}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-08-03T00:00:00.000Z",
        commandId: CommandId.make("cmd-thread-archive-parent"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-archive-parent"),
        metadata: {},
        type: "thread.archived",
        payload: {
          threadId,
          archivedAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      }) satisfies Extract<OrchestrationEvent, { type: "thread.archived" }>;

    const events = await Effect.runPromise(
      Effect.all([
        toShellStreamEvent(query, archiveEvent(ThreadId.make("parent"), 1)),
        toShellStreamEvent(query, archiveEvent(ThreadId.make("child"), 2)),
      ]),
    );

    expect(activeShellReads).toBe(0);
    expect(events.every(Option.isSome)).toBe(true);
    expect(
      events
        .flatMap((event) => (Option.isSome(event) ? [event.value] : []))
        .map((event) => (event.kind === "thread-removed" ? event.threadId : null)),
    ).toEqual([ThreadId.make("parent"), ThreadId.make("child")]);
  });
});

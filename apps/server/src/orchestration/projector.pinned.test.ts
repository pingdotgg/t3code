import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

it.effect("projects pin lifecycle events", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    expect(created.threads[0]?.pinnedAt ?? null).toBeNull();

    const pinned = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.pinned",
        payload: { threadId: ThreadId.make("thread-1"), pinnedAt: now, updatedAt: now },
      }),
    );
    expect(pinned.threads[0]?.pinnedAt).toBe(now);

    const unpinned = yield* projectEvent(
      pinned,
      makeEvent({
        sequence: 3,
        type: "thread.unpinned",
        payload: { threadId: ThreadId.make("thread-1"), updatedAt: now },
      }),
    );
    expect(unpinned.threads[0]?.pinnedAt).toBeNull();
  }),
);

it.effect("projects pin order key lifecycle", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    expect(created.threads[0]?.pinOrderKey ?? null).toBeNull();

    // Fresh pin carries the client's slot in the arranged order.
    const pinned = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.pinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          pinnedAt: now,
          pinOrderKey: "g",
          updatedAt: now,
        },
      }),
    );
    expect(pinned.threads[0]?.pinOrderKey).toBe("g");

    // Re-pins and events from pre-reorder servers omit the field entirely;
    // the existing key must survive rather than being nulled out.
    const repinned = yield* projectEvent(
      pinned,
      makeEvent({
        sequence: 3,
        type: "thread.pinned",
        payload: { threadId: ThreadId.make("thread-1"), pinnedAt: now, updatedAt: now },
      }),
    );
    expect(repinned.threads[0]?.pinOrderKey).toBe("g");

    // A drag persists the new slot.
    const reordered = yield* projectEvent(
      repinned,
      makeEvent({
        sequence: 4,
        type: "thread.pin-reordered",
        payload: { threadId: ThreadId.make("thread-1"), orderKey: "m", updatedAt: now },
      }),
    );
    expect(reordered.threads[0]?.pinOrderKey).toBe("m");

    // Unpin clears the slot: re-pinning is "pin again", not "restore an
    // ancient position".
    const unpinned = yield* projectEvent(
      reordered,
      makeEvent({
        sequence: 5,
        type: "thread.unpinned",
        payload: { threadId: ThreadId.make("thread-1"), updatedAt: now },
      }),
    );
    expect(unpinned.threads[0]?.pinOrderKey).toBeNull();
  }),
);

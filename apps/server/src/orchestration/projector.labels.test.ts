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

it.effect("projects thread labels and clears them", () =>
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
    expect(created.threads[0]?.label ?? null).toBeNull();

    const labeled = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          label: "review",
          updatedAt: now,
        },
      }),
    );
    expect(labeled.threads[0]?.label).toBe("review");

    const cleared = yield* projectEvent(
      labeled,
      makeEvent({
        sequence: 3,
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          label: null,
          updatedAt: now,
        },
      }),
    );
    expect(cleared.threads[0]?.label).toBeNull();
  }),
);

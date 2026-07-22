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

it.effect("projects settled lifecycle events", () =>
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
    const settled = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.settled",
        payload: { threadId: ThreadId.make("thread-1"), settledAt: now, updatedAt: now },
      }),
    );
    expect(settled.threads[0]?.settledOverride).toBe("settled");
    expect(settled.threads[0]?.settledAt).toBe(now);

    const userUnsettled = yield* projectEvent(
      settled,
      makeEvent({
        sequence: 3,
        type: "thread.unsettled",
        payload: { threadId: ThreadId.make("thread-1"), reason: "user", updatedAt: now },
      }),
    );
    expect(userUnsettled.threads[0]?.settledOverride).toBe("active");
    expect(userUnsettled.threads[0]?.settledAt).toBeNull();

    const activityUnsettled = yield* projectEvent(
      userUnsettled,
      makeEvent({
        sequence: 4,
        type: "thread.unsettled",
        payload: { threadId: ThreadId.make("thread-1"), reason: "activity", updatedAt: now },
      }),
    );
    expect(activityUnsettled.threads[0]?.settledOverride).toBeNull();
    expect(activityUnsettled.threads[0]?.settledAt).toBeNull();
  }),
);

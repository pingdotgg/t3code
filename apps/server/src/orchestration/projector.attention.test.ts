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

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const makeEvent = (
  sequence: number,
  type: OrchestrationEvent["type"],
  payload: unknown,
): OrchestrationEvent =>
  ({
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: payload as never,
  }) as OrchestrationEvent;

it.effect("projects the thread attention lifecycle", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent(1, "thread.created", {
        threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    expect(created.threads[0]?.attention).toBeNull();

    const attention = { kind: "question", raisedAt: now } as const;
    const marked = yield* projectEvent(
      created,
      makeEvent(2, "thread.attention-set", {
        threadId,
        attention,
        updatedAt: now,
      }),
    );
    expect(marked.threads[0]?.attention).toEqual(attention);

    const cleared = yield* projectEvent(
      marked,
      makeEvent(3, "thread.attention-cleared", { threadId, updatedAt: now }),
    );
    expect(cleared.threads[0]?.attention).toBeNull();
  }),
);

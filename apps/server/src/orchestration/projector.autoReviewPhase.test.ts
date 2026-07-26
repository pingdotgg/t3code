import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:01:00.000Z";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateId: string;
  commandId: string;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const threadCreatedEvent = makeEvent({
  sequence: 1,
  type: "thread.created",
  occurredAt: NOW,
  aggregateId: "thread-1",
  commandId: "cmd-thread-create",
  payload: {
    threadId: "thread-1",
    projectId: ProjectId.make("project-1"),
    title: "demo",
    modelSelection: {
      provider: ProviderDriverKind.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

it.effect("applies thread.auto-review-phase-set events", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), threadCreatedEvent);
    expect(created.threads[0]?.autoReviewPhase).toBe(null);

    const phaseSet = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.auto-review-phase-set",
        occurredAt: LATER,
        aggregateId: "thread-1",
        commandId: "cmd-auto-review-set",
        payload: {
          threadId: "thread-1",
          phase: "reviewing",
          updatedAt: LATER,
        },
      }),
    );
    expect(phaseSet.threads[0]?.autoReviewPhase).toBe("reviewing");
    expect(phaseSet.threads[0]?.updatedAt).toBe(LATER);

    const phaseCleared = yield* projectEvent(
      phaseSet,
      makeEvent({
        sequence: 3,
        type: "thread.auto-review-phase-set",
        occurredAt: LATER,
        aggregateId: "thread-1",
        commandId: "cmd-auto-review-clear",
        payload: {
          threadId: "thread-1",
          phase: null,
          updatedAt: LATER,
        },
      }),
    );
    expect(phaseCleared.threads[0]?.autoReviewPhase).toBe(null);
  }).pipe(Effect.orDie),
);

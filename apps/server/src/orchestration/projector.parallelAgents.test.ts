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

const NOW = "2026-01-01T00:00:00.000Z";

function makeThreadCreatedEvent(input: {
  readonly sequence: number;
  readonly threadId: string;
  readonly parentThreadId?: string | null;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: ThreadId.make(input.threadId),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: ThreadId.make(input.threadId),
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
      createdAt: NOW,
      updatedAt: NOW,
    } as never,
  } as OrchestrationEvent;
}

it.effect("projects the parallel-agent parent link on thread.created", () =>
  Effect.gen(function* () {
    const withParent = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeThreadCreatedEvent({
        sequence: 1,
        threadId: "thread-child",
        parentThreadId: "thread-parent",
      }),
    );
    expect(withParent.threads[0]?.parentThreadId).toBe("thread-parent");

    // Events persisted by older servers have no parentThreadId at all.
    const withoutParent = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeThreadCreatedEvent({ sequence: 1, threadId: "thread-plain" }),
    );
    expect(withoutParent.threads[0]?.parentThreadId).toBe(null);
  }),
);

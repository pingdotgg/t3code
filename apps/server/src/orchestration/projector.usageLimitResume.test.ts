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

function event(
  sequence: number,
  type: OrchestrationEvent["type"],
  payload: unknown,
): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: payload as never,
  } as OrchestrationEvent;
}

it.effect("projects the complete usage-limit resume lifecycle", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      event(1, "thread.created", {
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
      }),
    );
    const resumeAt = "2026-01-01T01:00:00.000Z";
    const scheduled = yield* projectEvent(
      created,
      event(2, "thread.usage-limit-resume-scheduled", {
        threadId: ThreadId.make("thread-1"),
        resumeAt,
        attempt: 0,
        updatedAt: now,
      }),
    );
    expect(scheduled.threads[0]?.usageLimitResume).toEqual({
      nextAttemptAt: resumeAt,
      attempt: 0,
    });

    const attempted = yield* projectEvent(
      scheduled,
      event(3, "thread.usage-limit-resume-attempted", {
        threadId: ThreadId.make("thread-1"),
        expectedAttemptAt: resumeAt,
        attempt: 0,
        shouldResume: true,
        updatedAt: resumeAt,
      }),
    );
    expect(attempted.threads[0]?.usageLimitResume).toEqual({ nextAttemptAt: null, attempt: 0 });

    const cancelled = yield* projectEvent(
      attempted,
      event(4, "thread.usage-limit-resume-cancelled", {
        threadId: ThreadId.make("thread-1"),
        updatedAt: resumeAt,
      }),
    );
    expect(cancelled.threads[0]?.usageLimitResume).toBeNull();
  }),
);

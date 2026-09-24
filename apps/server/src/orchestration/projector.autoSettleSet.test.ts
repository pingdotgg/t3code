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

it.effect("projects auto-settle opt-out and survives a manual settle", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-02T00:00:00.000Z";
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
    expect(created.threads[0]?.autoSettleDisabledAt ?? null).toBeNull();

    const disabled = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.auto-settle-set",
        payload: { threadId: ThreadId.make("thread-1"), autoSettleDisabledAt: now, updatedAt: now },
      }),
    );
    expect(disabled.threads[0]?.autoSettleDisabledAt).toBe(now);

    // The flag is independent of the settled lifecycle: settling by hand and
    // un-settling later must not clear it.
    const settled = yield* projectEvent(
      disabled,
      makeEvent({
        sequence: 3,
        type: "thread.settled",
        payload: { threadId: ThreadId.make("thread-1"), settledAt: later, updatedAt: later },
      }),
    );
    expect(settled.threads[0]?.settledOverride).toBe("settled");
    expect(settled.threads[0]?.autoSettleDisabledAt).toBe(now);

    const unsettled = yield* projectEvent(
      settled,
      makeEvent({
        sequence: 4,
        type: "thread.unsettled",
        payload: { threadId: ThreadId.make("thread-1"), reason: "user", updatedAt: later },
      }),
    );
    expect(unsettled.threads[0]?.autoSettleDisabledAt).toBe(now);

    const enabled = yield* projectEvent(
      unsettled,
      makeEvent({
        sequence: 5,
        type: "thread.auto-settle-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          autoSettleDisabledAt: null,
          updatedAt: later,
        },
      }),
    );
    expect(enabled.threads[0]?.autoSettleDisabledAt).toBeNull();
  }),
);

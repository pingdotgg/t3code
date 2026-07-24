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

const NOW = "2026-07-23T12:00:00.000Z";
const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
  ({
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  }) as OrchestrationEvent;

it.effect("projects the monitor lifecycle without changing settledOverride", () =>
  Effect.gen(function* () {
    let model = yield* projectEvent(
      createEmptyReadModel(NOW),
      event(1, "thread.created", {
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    model = yield* projectEvent(
      model,
      event(2, "thread.monitor-started", {
        threadId: ThreadId.make("thread-1"),
        prNumber: 42,
        blockersSummary: "draft",
        headSha: "abc",
        wakeCount: 0,
        startedAt: NOW,
      }),
    );
    expect(model.threads[0]?.monitor?.status).toBe("monitoring");
    expect(model.threads[0]?.settledOverride).toBeNull();
    model = yield* projectEvent(
      model,
      event(3, "thread.monitor-snapshot-updated", {
        threadId: ThreadId.make("thread-1"),
        blockersSummary: "CI",
        headSha: "def",
        wakeCount: 2,
        updatedAt: NOW,
      }),
    );
    expect(model.threads[0]?.monitor?.wakeCount).toBe(2);
    model = yield* projectEvent(
      model,
      event(4, "thread.monitor-ended", {
        threadId: ThreadId.make("thread-1"),
        reason: "ready",
        blockersSummary: "",
        endedAt: NOW,
      }),
    );
    expect(model.threads[0]?.monitor?.status).toBe("ready");
    expect(model.threads[0]?.monitor?.endedReason).toBe("ready");
    expect(model.threads[0]?.settledOverride).toBeNull();
  }),
);

import { EventId, TaskId, ProjectId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
const now = "2026-01-01T00:00:00.000Z";
it.effect("replays empty task creation and sparse metadata updates deterministically", () =>
  Effect.gen(function* () {
    const base = {
      sequence: 1,
      eventId: EventId.make("event"),
      aggregateKind: "task" as const,
      aggregateId: TaskId.make("task"),
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    const created: OrchestrationEvent = {
      ...base,
      type: "task.created",
      payload: {
        taskId: TaskId.make("task"),
        name: "Task",
        description: "Description",
        primaryProjectId: ProjectId.make("project"),
        createdAt: now,
        updatedAt: now,
      },
    };
    let model = yield* projectEvent(createEmptyReadModel(now), created);
    model = yield* projectEvent(model, created);
    expect(model.tasks).toHaveLength(1);
    model = yield* projectEvent(model, {
      ...base,
      sequence: 2,
      type: "task.meta-updated",
      payload: { taskId: TaskId.make("task"), description: null, updatedAt: now },
    });
    expect(model.tasks[0]).toMatchObject({
      name: "Task",
      description: null,
      primaryProjectId: "project",
      pinnedAt: null,
      deletedAt: null,
    });
    expect(model.threads).toEqual([]);
    const unchanged = yield* projectEvent(model, {
      ...base,
      aggregateKind: "thread",
      aggregateId: ThreadId.make("missing"),
      sequence: 3,
      type: "thread.task-set",
      payload: { threadId: ThreadId.make("missing"), taskId: null, updatedAt: now },
    });
    expect(unchanged.threads).toEqual([]);
  }),
);

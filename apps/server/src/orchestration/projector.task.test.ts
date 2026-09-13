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

const taskId = TaskId.make("lifecycle-task");
const later = "2026-01-02T00:00:00.000Z";
const future = "2026-01-03T00:00:00.000Z";
const taskEventFields = {
  sequence: 1,
  eventId: EventId.make("task-lifecycle-event"),
  aggregateKind: "task" as const,
  aggregateId: taskId,
  occurredAt: later,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};
const taskCreated: OrchestrationEvent = {
  ...taskEventFields,
  type: "task.created",
  payload: {
    taskId,
    name: "Lifecycle",
    description: null,
    primaryProjectId: ProjectId.make("project"),
    createdAt: now,
    updatedAt: now,
  },
};

it.effect(
  "settlement clears task parking and pin state while user reopening protects active state",
  () =>
    Effect.gen(function* () {
      let model = yield* projectEvent(createEmptyReadModel(now), taskCreated);
      const changes: OrchestrationEvent[] = [
        {
          ...taskEventFields,
          type: "task.pinned",
          payload: { taskId, pinnedAt: now, pinOrderKey: "a0", updatedAt: now },
        },
        {
          ...taskEventFields,
          type: "task.snoozed",
          payload: { taskId, snoozedUntil: future, snoozedAt: now, updatedAt: now },
        },
        {
          ...taskEventFields,
          type: "task.active-reordered",
          payload: { taskId, orderKey: "a1", updatedAt: now },
        },
        {
          ...taskEventFields,
          type: "task.settled",
          payload: { taskId, settledAt: now, updatedAt: now },
        },
      ];
      for (const change of changes) model = yield* projectEvent(model, change);
      expect(model.tasks[0]).toMatchObject({
        settledOverride: "settled",
        settledAt: now,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
      });
      model = yield* projectEvent(model, {
        ...taskEventFields,
        type: "task.unsettled",
        payload: { taskId, reason: "user", updatedAt: later },
      });
      expect(model.tasks[0]).toMatchObject({
        settledOverride: "active",
        settledAt: null,
        unsettledAt: later,
      });
      expect(model.threads).toEqual([]);
    }),
);

it.effect(
  "activity clears protection without reordering, but waking a snoozed task resets its slot",
  () =>
    Effect.gen(function* () {
      let model = yield* projectEvent(createEmptyReadModel(now), taskCreated);
      const changes: OrchestrationEvent[] = [
        {
          ...taskEventFields,
          type: "task.unsettled",
          payload: { taskId, reason: "user", updatedAt: now },
        },
        {
          ...taskEventFields,
          type: "task.active-reordered",
          payload: { taskId, orderKey: "a1", updatedAt: now },
        },
        {
          ...taskEventFields,
          type: "task.unsettled",
          payload: { taskId, reason: "activity", updatedAt: later },
        },
      ];
      for (const change of changes) model = yield* projectEvent(model, change);
      expect(model.tasks[0]).toMatchObject({
        settledOverride: null,
        unsettledAt: now,
        activeOrderKey: "a1",
      });
      model = yield* projectEvent(model, {
        ...taskEventFields,
        type: "task.snoozed",
        payload: { taskId, snoozedUntil: future, snoozedAt: now, updatedAt: now },
      });
      model = yield* projectEvent(model, {
        ...taskEventFields,
        type: "task.unsettled",
        payload: { taskId, reason: "activity", updatedAt: later },
      });
      expect(model.tasks[0]).toMatchObject({
        settledOverride: null,
        unsettledAt: later,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
      });
      model = yield* projectEvent(model, {
        ...taskEventFields,
        type: "task.active-reordered",
        payload: { taskId, orderKey: "a2", updatedAt: later },
      });
      model = yield* projectEvent(model, {
        ...taskEventFields,
        type: "task.unsettled",
        payload: { taskId, reason: "activity", updatedAt: future },
      });
      expect(model.tasks[0]).toMatchObject({ unsettledAt: later, activeOrderKey: "a2" });
    }),
);

it.effect("expired snooze visibility and duplicate user reopening preserve an arranged slot", () =>
  Effect.gen(function* () {
    let model = yield* projectEvent(createEmptyReadModel(now), taskCreated);
    const changes: OrchestrationEvent[] = [
      {
        ...taskEventFields,
        type: "task.unsettled",
        payload: { taskId, reason: "user", updatedAt: now },
      },
      {
        ...taskEventFields,
        type: "task.active-reordered",
        payload: { taskId, orderKey: "a1", updatedAt: now },
      },
      {
        ...taskEventFields,
        type: "task.unsettled",
        payload: { taskId, reason: "user", updatedAt: now },
      },
      {
        ...taskEventFields,
        type: "task.snoozed",
        payload: {
          taskId,
          snoozedUntil: "2026-01-03T01:00:00.000+02:00",
          snoozedAt: now,
          updatedAt: now,
        },
      },
      {
        ...taskEventFields,
        type: "task.unsettled",
        payload: { taskId, reason: "activity", updatedAt: future },
      },
    ];
    for (const change of changes) model = yield* projectEvent(model, change);
    expect(model.tasks[0]).toMatchObject({
      settledOverride: null,
      unsettledAt: now,
      activeOrderKey: "a1",
      snoozedUntil: null,
    });
  }),
);

it.effect("duplicate user unsettle preserves active ordering after a metadata edit", () =>
  Effect.gen(function* () {
    let model = yield* projectEvent(createEmptyReadModel(now), taskCreated);
    const changes: OrchestrationEvent[] = [
      {
        ...taskEventFields,
        type: "task.unsettled",
        payload: { taskId, reason: "user", updatedAt: now },
      },
      {
        ...taskEventFields,
        type: "task.active-reordered",
        payload: { taskId, orderKey: "a1", updatedAt: now },
      },
      {
        ...taskEventFields,
        type: "task.meta-updated",
        payload: { taskId, name: "Renamed", updatedAt: later },
      },
    ];
    for (const change of changes) model = yield* projectEvent(model, change);
    const before = model.tasks[0];
    expect(before).toMatchObject({
      settledOverride: "active",
      unsettledAt: now,
      updatedAt: later,
      activeOrderKey: "a1",
    });
    model = yield* projectEvent(model, {
      ...taskEventFields,
      type: "task.unsettled",
      payload: { taskId, reason: "user", updatedAt: later },
    });
    expect(model.tasks[0]).toEqual(before);
  }),
);

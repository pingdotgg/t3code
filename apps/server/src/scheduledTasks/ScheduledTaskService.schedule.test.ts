import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  type ScheduledTaskSchedule,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const launchingDependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Scheduler.layer,
  Layer.mock(ThreadLaunchService)({
    launch: () =>
      Effect.succeed({
        threadId: ThreadId.make("thread:scheduled-run"),
        projection: {} as unknown as OrchestrationV2ThreadProjection,
        resumed: false,
      }),
  }),
  Layer.mock(ThreadManagementService)({}),
);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      // Cross the due time before the scheduler's first five-second tick.
      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("a maxRuns cap pauses the task when reached and re-arms when raised", () =>
  Effect.gen(function* () {
    const mondayOpen = DateTime.makeZonedUnsafe(
      { year: 2026, month: 9, day: 28, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    const halfHourLater = DateTime.formatIso(
      DateTime.toUtc(DateTime.add(mondayOpen, { minutes: 30 })),
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(mondayOpen));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert({
        commandId: CommandId.make("schedule-run-cap"),
        title: "Half-hourly check",
        prompt: "Check the queue.",
        enabled: true,
        schedule: {
          type: "interval",
          everyMs: 1_800_000,
          weekdays: [1, 2, 3, 4, 5],
          window: { start: "09:00", end: "17:00" },
          maxRuns: 2,
        },
        projectId: ProjectId.make("project-schedule-run-cap"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const id = created.task.id;
      expect(created.task.nextRunAt).toBe(halfHourLater);

      const first = yield* service.runNow({ id });
      expect(first.task.runCount).toBe(1);
      expect(first.task.enabled).toBe(true);
      // The interval recomputes from the completion instant (still 09:00 on the test clock).
      expect(first.task.nextRunAt).toBe(halfHourLater);

      const second = yield* service.runNow({ id });
      expect(second.task.runCount).toBe(2);
      // The cap is reached: the task pauses itself instead of staying armed.
      expect(second.task.enabled).toBe(false);
      expect(second.task.nextRunAt).toBe(null);
      const stored = (yield* service.list()).tasks.find((task) => task.id === id);
      expect(stored?.enabled).toBe(false);
      expect(stored?.nextRunAt).toBe(null);

      // Re-enabling a capped task is refused while the cap is reached.
      const reenabled = yield* service.setEnabled({ id, enabled: true });
      expect(reenabled.task.enabled).toBe(false);
      expect(reenabled.task.nextRunAt).toBe(null);

      // An edit that raises the cap is the way back: the run clock restarts.
      // The editor sends the row's current enabled flag alongside the schedule.
      const edit = (schedule: ScheduledTaskSchedule, enabled: boolean) =>
        service.upsert({
          id,
          title: "Half-hourly check",
          prompt: "Check the queue.",
          enabled,
          schedule,
          projectId: created.task.projectId,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const raised = yield* edit({ type: "interval", everyMs: 1_800_000, maxRuns: 3 }, true);
      expect(raised.task.enabled).toBe(true);
      expect(raised.task.nextRunAt).toBe(halfHourLater);

      // Removing the cap from an automatically paused task (saved from the
      // paused row) resumes it without a separate enable: the pause was the
      // cap's doing.
      const third = yield* service.runNow({ id });
      expect(third.task.runCount).toBe(3);
      expect(third.task.enabled).toBe(false);
      const uncapped = yield* edit({ type: "interval", everyMs: 1_800_000 }, false);
      expect(uncapped.task.enabled).toBe(true);
      expect(uncapped.task.nextRunAt).toBe(halfHourLater);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(launchingDependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("skips a due task whose window closed while an earlier dispatch ran", () =>
  Effect.gen(function* () {
    const zone = { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true };
    const at = (hour: number, minute: number, day = 28) =>
      DateTime.makeZonedUnsafe(
        { year: 2026, month: 9, day, hour, minute, second: 0, millisecond: 0 },
        zone,
      );
    yield* TestClock.setTime(DateTime.toEpochMillis(at(16, 29)));
    let launches = 0;
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService)({
        launch: () =>
          Effect.gen(function* () {
            launches += 1;
            // The first dispatch is slow: it finishes after the window closed.
            yield* TestClock.setTime(DateTime.toEpochMillis(at(17, 10)));
            return {
              threadId: ThreadId.make("thread:scheduled-run"),
              projection: {} as unknown as OrchestrationV2ThreadProjection,
              resumed: false,
            };
          }),
      }),
      Layer.mock(ThreadManagementService)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const create = (commandId: string) =>
        service.upsert({
          commandId: CommandId.make(commandId),
          title: commandId,
          prompt: "Check the queue.",
          enabled: true,
          schedule: {
            type: "interval",
            everyMs: 1_800_000,
            weekdays: [1, 2, 3, 4, 5],
            window: { start: "09:00", end: "17:00" },
          },
          projectId: ProjectId.make("project-window-dispatch"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      yield* create("window-a");
      yield* create("window-b");

      // Both come due at 16:59, inside the window; the poll then runs one
      // task and must skip the other because 17:10 is past the close.
      yield* TestClock.setTime(DateTime.toEpochMillis(at(16, 59)));
      yield* TestClock.adjust("5 seconds");
      // Wait on the change stream until both tasks are re-aimed at tomorrow.
      const nextDay = DateTime.formatIso(DateTime.toUtc(at(9, 0, 29)));
      yield* service.subscribeList().pipe(
        Stream.filter(({ tasks }) => tasks.every((task) => task.nextRunAt === nextDay)),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(launches).toBe(1);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

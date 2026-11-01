import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
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
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
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
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
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
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

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
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the task list order when a toggle or edit rewrites updated_at", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = (id: string) => ({
        id,
        title: id,
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stable-order",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const listedIds = service
        .list()
        .pipe(Effect.map(({ tasks }) => tasks.map((task) => String(task.id))));

      const older = yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:older")));
      yield* TestClock.adjust("1 second");
      yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:newer")));
      const order = ["scheduled-task:newer", "scheduled-task:older"];
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const toggled = yield* service.setEnabled({ id: older.task.id, enabled: false });
      expect(toggled.task.updatedAt > older.task.updatedAt).toBe(true);
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const edit = { ...input(older.task.id), requireExisting: true, title: "Edited" };
      yield* service.upsert(yield* decodeUpsertInput({ ...edit, enabled: false }));
      expect(yield* listedIds).toEqual(order);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("runs a fixed-time slot missed during sleep once only when the task asks for it", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 7, minute: 30, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    const dueIso = DateTime.formatIso(DateTime.toUtc(dueAt));
    const nextWeekIso = DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { days: 7 })));
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const launches = yield* Ref.make(0);
    const activate = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () =>
          Ref.update(launches, (n) => n + 1).pipe(
            Effect.andThen(Effect.die("synthetic dispatch failure")),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const save = (commandId: string, schedule: Record<string, unknown>) =>
        decodeUpsertInput({
          commandId,
          title: "Weekly review",
          prompt: "Review the open pull requests.",
          enabled: true,
          schedule: {
            type: "fixed_time",
            timeOfDay: "07:30",
            weekdays: [DateTime.toParts(dueAt).weekDay],
            ...schedule,
          },
          projectId: "project-missed-run",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }).pipe(Effect.flatMap(service.upsert));

      const catchUp = yield* save("catch-up", { missedRun: "run_once" });
      // A client that predates missedRun re-saves without it.
      const resaved = yield* save("catch-up", {});
      expect(resaved.task.schedule).toMatchObject({ missedRun: "run_once" });
      expect(resaved.task.nextRunAt).toBe(dueIso);
      yield* save("skip", { missedRun: "run_once" });
      const skipped = yield* save("skip", { missedRun: "skip" });
      expect(skipped.task.schedule).toMatchObject({ missedRun: "skip" });

      // Asleep through the slot: the scheduler first polls two days later.
      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 2 * 24 * 60 * 60_000);
      const settled = yield* service.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks),
        Stream.filter((tasks) =>
          tasks.every((task) => task.lastRunStatus !== "running" && task.nextRunAt !== dueIso),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.succeed(activate, undefined);
      const tasks = Option.getOrThrow(yield* Fiber.join(settled));
      const byId = new Map(tasks.map((task) => [task.id, task]));

      expect(yield* Ref.get(launches)).toBe(1);
      expect(byId.get(catchUp.task.id)).toMatchObject({ runCount: 1, nextRunAt: nextWeekIso });
      expect(byId.get(skipped.task.id)).toMatchObject({ runCount: 0, nextRunAt: nextWeekIso });
    }).pipe(
      Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))),
      Effect.provideService(ServerActivation, Deferred.await(activate)),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "idle polls still wake for tasks saved later, recorded due times, and beside far-future tasks",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
      const launched = yield* Deferred.make<string>();
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Deferred.succeed(launched, input.title).pipe(
              Effect.as({ threadId: "thread-idle-poll", resumed: false } as never),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        // The first poll finds no tasks and remembers that nothing is due.
        yield* TestClock.adjust("6 seconds");
        // Its year-10000+ next run sorts first as text; it must not hide the task below.
        yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Far future",
            prompt: "Review the open pull requests.",
            enabled: true,
            schedule: { type: "interval", everyMs: 3e14 },
            projectId: "project-idle-poll",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        const created = yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Idle poll",
            prompt: "Review the open pull requests.",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: "project-idle-poll",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        // This poll records the new task's due time; the later ones must still fire it.
        yield* TestClock.adjust("6 seconds");
        yield* TestClock.adjust("60 seconds");
        expect(yield* Deferred.await(launched)).toBe(created.task.title);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

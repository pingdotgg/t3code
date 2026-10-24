import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { isScheduledTaskCompleted, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import { listDueTasks } from "./ScheduledTaskService.ts";
import { ServerActivation } from "../serverActivation.ts";

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

it.effect(
  "persists custom formats and preserves recurrence anchors through edits, toggles and restart",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00Z"));
      const dependencies = Layer.mergeAll(
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
      const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:rrule-anchor",
        title: "Fortnightly review",
        prompt: "Review the project.",
        enabled: true,
        schedule: {
          type: "custom",
          expression: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
          timeZone: "Europe/Berlin",
        },
        projectId: "project-custom",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          const created = (yield* service.upsert(input)).task;
          expect(created.schedule).toMatchObject({
            type: "custom",
            format: "rrule",
            startAt: "2026-01-01T00:00:00.000Z",
            timeZone: "Europe/Berlin",
          });
          expect(created.nextRunAt).toBe("2026-01-12T08:00:00.000Z");
          yield* TestClock.setTime(Date.parse("2026-01-03T12:00:00Z"));
          const edited = (yield* service.upsert({
            ...input,
            id: created.id,
            title: "Renamed",
            schedule: {
              type: "custom",
              expression: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
            },
          })).task;
          expect(edited.schedule).toEqual(created.schedule);
          expect(edited.nextRunAt).toBe(created.nextRunAt);
          yield* service.setEnabled({ id: created.id, enabled: false });
          const resumed = (yield* service.setEnabled({ id: created.id, enabled: true })).task;
          expect(resumed.schedule).toEqual(created.schedule);
          expect(resumed.nextRunAt).toBe(created.nextRunAt);
          const preview = yield* service.preview({
            id: created.id,
            schedule: {
              type: "custom",
              expression: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0",
            },
          });
          expect(preview.schedule.startAt).toBe(
            created.schedule.type === "custom" ? created.schedule.startAt : "",
          );
          expect(preview.occurrences[0]).toBe("2026-01-13T08:00:00.000Z");
          const bad = yield* service
            .upsert({
              ...input,
              id: created.id,
              schedule: { type: "custom", expression: "FREQ=DAILY;BYHOUR=25" },
            })
            .pipe(Effect.flip);
          expect(bad.message).toContain("BYHOUR");
          expect((yield* service.list()).tasks[0]).toEqual(resumed);
          return resumed;
        }).pipe(Effect.provide(serviceLayer)),
      );

      // A fresh service scope reads only the serialized SQLite row.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          expect((yield* service.list()).tasks[0]).toEqual(first);
          const updated = (yield* service.upsert({
            ...input,
            schedule: {
              type: "custom",
              expression: "FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0",
            },
          })).task;
          expect(updated.schedule.type === "custom" && updated.schedule.startAt).toBe(
            first.schedule.type === "custom" && first.schedule.startAt,
          );
          expect(updated.nextRunAt).toBe("2026-01-31T08:00:00.000Z");
          const cron = (yield* service.upsert({
            ...input,
            schedule: { type: "custom", expression: "0 9 1 * *", timeZone: "Europe/Berlin" },
          })).task;
          expect(cron.schedule).toMatchObject({
            format: "cron",
            startAt: "2026-01-01T00:00:00.000Z",
          });
          expect(cron.nextRunAt).toBe("2026-02-01T08:00:00.000Z");
        }).pipe(Effect.provide(serviceLayer)),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("completes finite rules without resurrecting them on edits or restart", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00Z"));
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () => Effect.die("synthetic dispatch failure"),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
    const input = yield* decodeUpsertInput({
      id: "scheduled-task:finite",
      title: "Twice",
      prompt: "Review.",
      enabled: true,
      schedule: {
        type: "custom",
        expression: "DTSTART:20260101T000100Z\nRRULE:FREQ=MINUTELY;COUNT=2",
      },
      projectId: "project-custom",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const ended = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const created = (yield* service.upsert(input)).task;
        expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
        yield* TestClock.setTime(Date.parse("2026-01-01T00:01:00Z"));
        const first = (yield* service.runNow({ id: created.id })).task;
        expect(first.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
        yield* TestClock.setTime(Date.parse("2026-01-01T00:02:00Z"));
        const last = (yield* service.runNow({ id: created.id })).task;
        expect(last.nextRunAt).toBeNull();
        expect(isScheduledTaskCompleted(last)).toBe(true);
        expect(last.runCount).toBe(2);
        const edited = (yield* service.upsert({
          ...input,
          title: "Completed review",
          schedule: { type: "custom", expression: "FREQ=MINUTELY;COUNT=2" },
        })).task;
        expect(edited.nextRunAt).toBeNull();
        expect(edited.schedule).toEqual(created.schedule);
        yield* service.setEnabled({ id: created.id, enabled: false });
        const resumed = (yield* service.setEnabled({ id: created.id, enabled: true })).task;
        expect(isScheduledTaskCompleted(resumed)).toBe(true);
        return resumed;
      }).pipe(Effect.provide(serviceLayer)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        expect((yield* service.list()).tasks[0]).toEqual(ended);
        const preview = yield* service.preview({
          id: ended.id,
          schedule: { type: "custom", expression: "FREQ=MINUTELY;COUNT=2" },
        });
        expect(preview.occurrences).toEqual([]);
        expect(preview.completed).toBe(true);
        expect(yield* listDueTasks(DateTime.makeUnsafe("2026-01-02T00:00:00Z"))).toEqual([]);
        const extended = (yield* service.upsert({
          ...input,
          schedule: { type: "custom", expression: "FREQ=MINUTELY;COUNT=3" },
        })).task;
        expect(extended.nextRunAt).toBe("2026-01-01T00:03:00.000Z");
        expect(isScheduledTaskCompleted(extended)).toBe(false);
      }).pipe(Effect.provide(serviceLayer)),
    );
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect(
  "anchors new rules at creation and runs COUNT=1 once without a preview changing the start",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T12:34:56.123Z"));
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () => Effect.die("synthetic dispatch failure"),
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
        const input = yield* decodeUpsertInput({
          id: "scheduled-task:starts-now",
          title: "Once",
          prompt: "Review.",
          enabled: true,
          schedule: { type: "custom", expression: "FREQ=DAILY;COUNT=1", timeZone: "UTC" },
          projectId: "project-custom",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const preview = yield* service.preview({
          schedule: { type: "custom", expression: "FREQ=DAILY;COUNT=1", timeZone: "UTC" },
        });
        expect(preview.schedule.startAt).toBe("2026-01-01T12:34:56.123Z");
        expect(preview.occurrences).toEqual(["2026-01-01T12:34:56.123Z"]);
        expect((yield* service.list()).tasks).toEqual([]);
        yield* TestClock.setTime(Date.parse("2026-01-01T12:35:01.456Z"));
        const created = (yield* service.upsert(input)).task;
        expect(created.schedule).toMatchObject({ startAt: "2026-01-01T12:35:01.456Z" });
        expect(created.nextRunAt).toBe("2026-01-01T12:35:01.456Z");
        expect(isScheduledTaskCompleted(created)).toBe(false);
        const completed = (yield* service.runNow({ id: created.id })).task;
        expect(completed.runCount).toBe(1);
        expect(isScheduledTaskCompleted(completed)).toBe(true);
        const edited = (yield* service.upsert({ ...input, title: "Renamed" })).task;
        expect(edited.schedule).toEqual(created.schedule);
        expect(edited.nextRunAt).toBeNull();
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
    }).pipe(
      Effect.provideService(ServerActivation, Effect.never),
      Effect.provide(SqlitePersistence.layerMemory),
    ),
);

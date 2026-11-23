import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

/** Test settings whose updates reach `subscribeChanges`, like the live service. */
const settingsLayer = (timeZone: string) =>
  Layer.effect(
    ServerSettingsModule.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettingsModule.ServerSettingsService;
      const changes = yield* PubSub.unbounded<ServerSettings>();
      return {
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      } satisfies ServerSettingsModule.ServerSettingsService["Service"];
    }),
  ).pipe(
    Layer.provide(
      ServerSettingsModule.ServerSettingsService.layerTest({ scheduledTaskTimeZone: timeZone }),
    ),
  );

const serviceLayer = (timeZone: string) =>
  ScheduledTaskService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ManagedPolicy.layerTest(),
        settingsLayer(timeZone),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );

const task = (id: string, schedule: unknown) =>
  decodeUpsertInput({
    id,
    title: id,
    prompt: "Check the overnight deploys.",
    enabled: true,
    schedule,
    projectId: "project-time-zone",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  });

// 06:00 in Denver, 21:00 in Tokyo.
const NOW = Date.parse("2026-07-01T12:00:00.000Z");

it.effect("moves pending daily runs to the same local time when the schedule zone changes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const daily = yield* service.upsert(
        yield* task("scheduled-task:daily", { type: "fixed_time", timeOfDay: "09:00" }),
      );
      const interval = yield* service.upsert(
        yield* task("scheduled-task:interval", { type: "interval", everyMs: 3_600_000 }),
      );
      const once = yield* service.upsert(
        yield* task("scheduled-task:once", { type: "once", runAt: "2026-07-03T10:00:00-06:00" }),
      );
      expect(daily.task.nextRunAt).toBe("2026-07-01T15:00:00.000Z");
      expect((yield* service.list()).timeZone).toBe("America/Denver");

      const moved = yield* service.subscribeList().pipe(
        Stream.filter((list) => list.timeZone === "Asia/Tokyo"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* settings.updateSettings({ scheduledTaskTimeZone: "Asia/Tokyo" });
      const list = yield* Fiber.join(moved).pipe(
        Effect.map((head) => head.pipe(Option.getOrThrow)),
      );
      const nextRuns = Object.fromEntries(list.tasks.map((entry) => [entry.id, entry.nextRunAt]));

      expect(nextRuns[daily.task.id]).toBe("2026-07-02T00:00:00.000Z");
      expect(nextRuns[interval.task.id]).toBe(interval.task.nextRunAt);
      expect(nextRuns[once.task.id]).toBe(once.task.nextRunAt);
    }).pipe(Effect.provide(serviceLayer("America/Denver")));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("moves pending daily runs on startup when the zone changed while stopped", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const created = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* service.upsert(
        yield* task("scheduled-task:daily", { type: "fixed_time", timeOfDay: "09:00" }),
      );
    }).pipe(Effect.provide(serviceLayer("America/Denver")));
    expect(created.task.nextRunAt).toBe("2026-07-01T15:00:00.000Z");

    const restarted = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* service.list();
    }).pipe(Effect.provide(serviceLayer("Asia/Tokyo")));
    expect(restarted.timeZone).toBe("Asia/Tokyo");
    expect(restarted.tasks[0]?.nextRunAt).toBe("2026-07-02T00:00:00.000Z");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not dispatch an old-zone run that is due at startup in a new zone", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(
        yield* task("scheduled-task:daily", { type: "fixed_time", timeOfDay: "09:00" }),
      );
    }).pipe(Effect.provide(serviceLayer("America/Denver")));

    // Back at 09:03 Denver, inside the missed-run grace, but now on Tokyo time (00:03).
    yield* TestClock.setTime(Date.parse("2026-07-01T15:03:00.000Z"));
    const [restarted] = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* TestClock.adjust("6 seconds");
      return (yield* service.list()).tasks;
    }).pipe(Effect.provide(serviceLayer("Asia/Tokyo")));
    expect(restarted?.lastRunStatus).toBe("never");
    expect(restarted?.nextRunAt).toBe("2026-07-02T00:00:00.000Z");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("moves a future run to the next occurrence even when it is valid in the new zone", () =>
  Effect.gen(function* () {
    // Monday 10:00 in Honolulu; Kiritimati is exactly a day ahead (Tuesday 10:00).
    yield* TestClock.setTime(Date.parse("2026-07-06T20:00:00.000Z"));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const { task: created } = yield* service.upsert(
        yield* task("scheduled-task:weekly", {
          type: "fixed_time",
          timeOfDay: "09:00",
          weekdays: [1, 3, 4],
        }),
      );
      // Wednesday 09:00 Honolulu, which is Thursday 09:00 in Kiritimati.
      expect(created.nextRunAt).toBe("2026-07-08T19:00:00.000Z");

      const moved = yield* service.subscribeList().pipe(
        Stream.filter((list) => list.timeZone === "Pacific/Kiritimati"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* settings.updateSettings({ scheduledTaskTimeZone: "Pacific/Kiritimati" });
      const list = yield* Fiber.join(moved).pipe(Effect.map(Option.getOrThrow));
      // Wednesday 09:00 Kiritimati comes first.
      expect(list.tasks[0]?.nextRunAt).toBe("2026-07-07T19:00:00.000Z");
    }).pipe(Effect.provide(serviceLayer("Pacific/Honolulu")));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

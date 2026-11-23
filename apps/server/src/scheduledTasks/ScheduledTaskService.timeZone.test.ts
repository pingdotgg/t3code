import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, type ServerSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
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

const serviceLayer = (
  timeZone: string,
  threadLaunch: Partial<ThreadLaunchService.ThreadLaunchService["Service"]> = {},
  webhookOrigin?: Effect.Effect<{ readonly relayHookBaseUrl: string | null }>,
  threadManagement: Partial<ThreadManagementService.ThreadManagementService["Service"]> = {},
  scheduler: Layer.Layer<Scheduler.Scheduler> = Scheduler.layer,
) =>
  ScheduledTaskService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        scheduler,
        ManagedPolicy.layerTest(),
        settingsLayer(timeZone),
        webhookOrigin === undefined
          ? Layer.empty
          : Layer.succeed(ScheduledTaskService.ScheduledTaskWebhookOrigin, webhookOrigin),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)(threadLaunch),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)(threadManagement),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );

/** Hands the scheduled-task due-work run to the test instead of ticking it on a timer. */
const capturingScheduler = (captured: Ref.Ref<Effect.Effect<void> | undefined>) =>
  Layer.succeed(Scheduler.Scheduler, {
    register: <E, R>(name: string, runDueWork: Effect.Effect<void, E, R>) =>
      name !== "scheduled-tasks"
        ? Effect.void
        : Effect.context<R>().pipe(
            Effect.flatMap((context) =>
              Ref.set(captured, runDueWork.pipe(Effect.provideContext(context), Effect.orDie)),
            ),
          ),
  });

const task = (
  id: string,
  schedule: unknown,
  workspaceStrategy: unknown = { type: "root" },
  threadId?: string,
) =>
  decodeUpsertInput({
    ...(threadId === undefined ? {} : { threadId }),
    id,
    title: id,
    prompt: "Check the overnight deploys.",
    enabled: true,
    schedule,
    projectId: "project-time-zone",
    workspaceStrategy,
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

/** Waits for the list a zone switch republishes after its reconciliation commits. */
const switchZone = (timeZone: string) =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    const settings = yield* ServerSettingsModule.ServerSettingsService;
    const switched = yield* service.subscribeList().pipe(
      Stream.filter((list) => list.timeZone === timeZone),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* settings.updateSettings({ scheduledTaskTimeZone: timeZone });
    yield* Fiber.join(switched);
  });

it.effect("a save that waits across a zone switch stores its run in the new zone", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      // Read the zone, then wait on Git detection while the zone switches.
      const saving = yield* service
        .upsert(
          yield* task(
            "scheduled-task:worktree",
            { type: "fixed_time", timeOfDay: "09:00" },
            { type: "worktree", baseRef: "main" },
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* switchZone("Asia/Tokyo");
      yield* Deferred.succeed(release, undefined);
      const { task: saved } = yield* Fiber.join(saving);
      expect(saved.nextRunAt).toBe("2026-07-02T00:00:00.000Z");
    }).pipe(
      Effect.provide(
        serviceLayer("America/Denver", {
          isNonGitProject: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(false),
            ),
        }),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run that completes across a zone switch schedules its next run in the new zone", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const armed = yield* Ref.make(false);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // The run reads the webhook origin after taking its completion time; pause it there.
    const webhookOrigin = Ref.getAndSet(armed, false).pipe(
      Effect.flatMap((pause) =>
        pause
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      ),
      Effect.as({ relayHookBaseUrl: null }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task: created } = yield* service.upsert(
        yield* task("scheduled-task:daily", { type: "fixed_time", timeOfDay: "09:00" }),
      );
      const running = yield* service.runNow({ id: created.id }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* switchZone("Asia/Tokyo");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      const [listed] = (yield* service.list()).tasks;
      expect(listed?.lastRunStatus).toBe("succeeded");
      expect(listed?.nextRunAt).toBe("2026-07-02T00:00:00.000Z");
    }).pipe(
      Effect.provide(
        serviceLayer(
          "America/Denver",
          {
            launch: () =>
              Ref.set(armed, true).pipe(
                Effect.as({ threadId: "thread-time-zone", resumed: false } as never),
              ),
          },
          webhookOrigin,
        ),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a scheduled run postponed by a zone switch during its queue check does not fire", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const runDueTasks = yield* Ref.make<Effect.Effect<void> | undefined>(undefined);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(
        yield* task(
          "scheduled-task:bound",
          { type: "fixed_time", timeOfDay: "09:00" },
          { type: "root" },
          "thread-bound",
        ),
      );
      // 09:00 Denver: the scheduler re-reads the task, then pauses in the thread queue check.
      yield* TestClock.setTime(Date.parse("2026-07-01T15:00:00.000Z"));
      const tick = yield* Ref.get(runDueTasks);
      if (tick === undefined) return yield* Effect.die("The scheduler was not registered.");
      const ticking = yield* Effect.forkChild(tick);
      yield* Deferred.await(entered);
      yield* switchZone("Asia/Tokyo");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(ticking);
      const [listed] = (yield* service.list()).tasks;
      expect(listed?.lastRunStatus).toBe("never");
      expect(listed?.nextRunAt).toBe("2026-07-02T00:00:00.000Z");
    }).pipe(
      Effect.provide(
        serviceLayer(
          "America/Denver",
          {},
          undefined,
          {
            getThreadShell: () =>
              Effect.succeed({
                projectId: "project-time-zone",
                archivedAt: null,
                deletedAt: null,
              } as never),
            getThreadRecords: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ runs: [], messages: [] } as never),
              ),
          },
          capturingScheduler(runDueTasks),
        ),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

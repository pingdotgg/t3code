import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  MessageId,
  RunId,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
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
      ManagedPolicy.layerTest(),
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
      ManagedPolicy.layerTest(),
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

it.effect("keeps one queued occurrence of a recurring task while its bound thread is busy", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    // The bound thread's own run never finishes, so every scheduled send lands
    // in its queue and stays there.
    const activeRun = {
      id: RunId.make("run:busy"),
      status: "running",
      userMessageId: MessageId.make("message:busy"),
    } as OrchestrationV2Run;
    const thread = yield* Ref.make<{
      readonly runs: ReadonlyArray<OrchestrationV2Run>;
      readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    }>({ runs: [activeRun], messages: [] });
    const runDueWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ManagedPolicy.layerTest(),
      // Capture the poll pass so the test drives each due interval directly.
      Layer.mock(Scheduler.Scheduler)({
        register: (name, work) =>
          name !== "scheduled-tasks"
            ? Effect.void
            : Effect.context<Effect.Services<typeof work>>().pipe(
                Effect.flatMap((context) =>
                  Ref.set(runDueWork, work.pipe(Effect.provideContext(context), Effect.ignore)),
                ),
              ),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: (input) =>
          Ref.modify(thread, (current) => {
            const run = {
              id: RunId.make(`run:${input.messageId}`),
              status: "queued",
              userMessageId: input.messageId,
            } as OrchestrationV2Run;
            const message = {
              id: input.messageId,
              threadId: input.threadId,
              runId: run.id,
              role: "user",
              text: input.text,
              ...(input.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: input.scheduledTaskId }),
            } as OrchestrationV2ConversationMessage;
            return [
              {
                delivery: "queued",
                run,
                message,
              } as ThreadManagementService.ThreadManagementSendResult,
              { runs: [...current.runs, run], messages: [...current.messages, message] },
            ];
          }),
        getThreadRecords: () => Ref.get(thread).pipe(Effect.map((records) => records as never)),
        getThreadShell: () =>
          Effect.succeed({
            projectId: "project-busy-thread",
            deletedAt: null,
            archivedAt: null,
          } as never),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* decodeUpsertInput({
          id: "scheduled-task:busy-thread",
          title: "Check progress",
          prompt: "Check progress",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: "project-busy-thread",
          threadId: "thread:busy",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      );

      for (let interval = 0; interval < 3; interval++) {
        yield* TestClock.adjust("61 seconds");
        yield* Effect.flatten(Ref.get(runDueWork));
      }

      const queuedOccurrencesOf = (taskId: typeof task.id) =>
        Ref.get(thread).pipe(
          Effect.map(
            ({ runs, messages }) =>
              runs
                .filter((run) => run.status === "queued")
                .map((run) => messages.find((message) => message.id === run.userMessageId))
                .filter((message) => message?.scheduledTaskId === taskId).length,
          ),
        );
      const queuedOccurrences = queuedOccurrencesOf(task.id);
      expect(yield* queuedOccurrences).toBe(1);
      // Skipped intervals still move the schedule forward.
      const [listed] = (yield* service.list()).tasks;
      expect(Date.parse(listed?.nextRunAt ?? "")).toBeGreaterThan(
        Date.parse("2026-07-01T09:03:03.000Z"),
      );

      // Run now is an explicit request, so it still queues behind the held one.
      yield* service.runNow({ id: task.id });
      expect(yield* queuedOccurrences).toBe(2);

      // Once the queued copies start, the next interval sends again.
      yield* Ref.update(thread, (current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.status === "queued" ? ({ ...run, status: "running" } as OrchestrationV2Run) : run,
        ),
      }));
      yield* TestClock.adjust("61 seconds");
      yield* Effect.flatten(Ref.get(runDueWork));
      expect(yield* queuedOccurrences).toBe(1);

      // A one-time task's only scheduled occurrence still sends behind a queued Run now.
      const { task: once } = yield* service.upsert(
        yield* decodeUpsertInput({
          id: "scheduled-task:busy-thread-once",
          title: "Check once",
          prompt: "Check once",
          enabled: true,
          schedule: { type: "once", runAt: "2026-07-01T09:05:00.000Z" },
          projectId: "project-busy-thread",
          threadId: "thread:busy",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      );
      yield* service.runNow({ id: once.id });
      yield* TestClock.adjust("61 seconds");
      yield* Effect.flatten(Ref.get(runDueWork));
      expect(yield* queuedOccurrencesOf(once.id)).toBe(2);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
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
        ManagedPolicy.layerTest(),
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

it.effect("a fixed-time slot missed while the server was off shows on the task", () =>
  Effect.gen(function* () {
    const at = (hour: number, minute = 0, day = 1) =>
      DateTime.makeZonedUnsafe(
        { year: 2026, month: 7, day, hour, minute, second: 0, millisecond: 0 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
    yield* TestClock.setTime(DateTime.toEpochMillis(at(8)));
    const launches = yield* Ref.make(0);
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () =>
          Ref.update(launches, (count) => count + 1).pipe(
            Effect.as({ threadId: "thread-missed-slot", resumed: false } as never),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    const withServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))),
      );

    const taskId = yield* withServer(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Morning bookkeeping",
            prompt: "Update yesterday's notes.",
            enabled: true,
            schedule: { type: "fixed_time", timeOfDay: "09:00" },
            projectId: "project-missed-slot",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        yield* service.runNow({ id: task.id });
        return task.id;
      }),
    );

    // The server is off across the 09:00 slot and comes back at 09:30.
    yield* TestClock.setTime(DateTime.toEpochMillis(at(9, 30)));
    const [listed] = yield* withServer(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* TestClock.adjust("6 seconds");
        return (yield* service.list()).tasks;
      }),
    );

    expect(listed?.id).toBe(taskId);
    expect(yield* Ref.get(launches)).toBe(1);
    expect(listed?.nextRunAt).toBe(DateTime.formatIso(DateTime.toUtc(at(9, 0, 2))));
    // The skipped slot must not read as the earlier manual run's clean success.
    expect({ status: listed?.lastRunStatus, error: listed?.lastRunError }).not.toEqual({
      status: "succeeded",
      error: null,
    });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a run made while the scheduler was busy is not overwritten by its stale missed slot",
  () =>
    Effect.gen(function* () {
      const at = (hour: number, minute = 0, day = 1) =>
        DateTime.makeZonedUnsafe(
          { year: 2026, month: 7, day, hour, minute, second: 0, millisecond: 0 },
          { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
        );
      yield* TestClock.setTime(DateTime.toEpochMillis(at(6)));
      const slowStarted = yield* Deferred.make<void>();
      const releaseSlow = yield* Deferred.make<void>();
      const lastProcessed = yield* Deferred.make<void>();
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            (input.title === "Slow"
              ? Deferred.succeed(slowStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSlow)),
                )
              : input.title === "Last"
                ? Deferred.succeed(lastProcessed, undefined)
                : Effect.void
            ).pipe(Effect.as({ threadId: `thread-${input.title}`, resumed: false } as never)),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      const withServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))),
        );
      const upsert = (
        title: string,
        schedule: { type: "interval"; everyMs: number } | { type: "fixed_time"; timeOfDay: string },
      ) =>
        Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          const { task } = yield* service.upsert(
            yield* decodeUpsertInput({
              title,
              prompt: "Update the notes.",
              enabled: true,
              schedule,
              projectId: "project-stale-slot",
              workspaceStrategy: { type: "root" },
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
            }),
          );
          return task.id;
        });

      // Due at 07:00, 08:00 and 08:30; the server is off until 09:30.
      const morningId = yield* withServer(
        Effect.gen(function* () {
          yield* upsert("Slow", { type: "interval", everyMs: 60 * 60 * 1000 });
          const id = yield* upsert("Morning", { type: "fixed_time", timeOfDay: "08:00" });
          yield* upsert("Last", { type: "interval", everyMs: 150 * 60 * 1000 });
          return id;
        }),
      );
      yield* TestClock.setTime(DateTime.toEpochMillis(at(9, 30)));
      const morning = yield* withServer(
        Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(slowStarted);
          yield* service.runNow({ id: morningId });
          yield* Deferred.succeed(releaseSlow, undefined);
          yield* Deferred.await(lastProcessed);
          return (yield* service.list()).tasks.find((task) => task.id === morningId);
        }),
      );

      expect({ status: morning?.lastRunStatus, error: morning?.lastRunError }).toEqual({
        status: "succeeded",
        error: null,
      });
      expect(morning?.nextRunAt).toBe(DateTime.formatIso(DateTime.toUtc(at(8, 0, 2))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

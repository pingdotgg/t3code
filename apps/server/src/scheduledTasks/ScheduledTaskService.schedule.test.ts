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

      const queuedOccurrences = Ref.get(thread).pipe(
        Effect.map(
          ({ runs, messages }) =>
            runs
              .filter((run) => run.status === "queued")
              .map((run) => messages.find((message) => message.id === run.userMessageId))
              .filter((message) => message?.scheduledTaskId === task.id).length,
        ),
      );
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
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

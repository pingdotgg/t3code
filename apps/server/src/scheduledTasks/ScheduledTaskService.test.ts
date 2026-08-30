import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTaskUpsertInput,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ScheduledTasks from "./ScheduledTaskService.ts";

const projectId = ProjectId.make("project:scheduled-run-now");
const otherProjectId = ProjectId.make("project:scheduled-run-now-other");
const callerThreadId = ThreadId.make("thread:scheduled-run-now-caller");
const boundThreadId = ThreadId.make("thread:scheduled-run-now-bound");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-codex",
} as const;
const project = {
  id: projectId,
  title: "Scheduled run project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in scheduler tests"),
} as ProviderAdapterV2Shape;

interface HarnessOptions {
  readonly getProject?: ProjectService.ProjectService["Service"]["getById"];
  readonly providerAdapter?: ProviderAdapterV2Shape | null;
  readonly mapThreadManagement?: (
    service: ThreadManagement.ThreadManagementService["Service"],
  ) => ThreadManagement.ThreadManagementService["Service"];
}

function makeHarness(options: HarnessOptions = {}) {
  const database = SqlitePersistenceMemory;
  const adapterRegistry = ProviderAdapterRegistry.makeLayer(
    options.providerAdapter === null ? [] : [options.providerAdapter ?? adapter],
  );
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "scheduled-run-now" },
    adapterRegistry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const threads = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const schedulerThreads =
    options.mapThreadManagement === undefined
      ? threads
      : Layer.effect(
          ThreadManagement.ThreadManagementService,
          Effect.gen(function* () {
            const service = yield* ThreadManagement.ThreadManagementService;
            return ThreadManagement.ThreadManagementService.of(
              options.mapThreadManagement!(service),
            );
          }),
        ).pipe(Layer.provide(threads));
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const externalServices = Layer.mergeAll(
    Layer.succeed(
      ProjectService.ProjectService,
      ProjectService.ProjectService.of({
        create: () => Effect.die("unused"),
        bootstrap: () => Effect.die("unused"),
        update: () => Effect.die("unused"),
        delete: () => Effect.die("unused"),
        getById:
          options.getProject ??
          ((id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none())),
        getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
        snapshot: Effect.die("unused"),
      }),
    ),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree: () => Effect.die("unused"),
      renameBranch: () => Effect.die("unused"),
      fetchRemote: () => Effect.die("unused"),
      removeWorktree: () => Effect.die("unused"),
      resolveRemoteTrackingCommit: () => Effect.die("unused"),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
    }),
    ServerSettings.layerTest(),
    makeProviderRegistryLayer(),
  );
  const launches = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(externalServices, threads, receipts, IdAllocator.layer)),
  );
  const scheduler = ScheduledTasks.layer.pipe(
    Layer.provide(Layer.mergeAll(database, launches, schedulerThreads)),
  );
  return Layer.mergeAll(database, orchestrator, threads, launches, scheduler).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
}

function createThread(input: {
  readonly commandId: string;
  readonly threadId: ThreadId;
  readonly project?: ProjectId;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly interactionMode?: "plan" | "default";
}) {
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.commandId),
      threadId: input.threadId,
      projectId: input.project ?? projectId,
      title: "Scheduled run test thread",
      modelSelection,
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      branch: null,
      worktreePath: "/repo",
      createdBy: "user",
      creationSource: "web",
    });
  });
}

function taskInput(input: {
  readonly id: ScheduledTaskId;
  readonly threadId: ThreadId | null;
  readonly project?: ProjectId;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly interactionMode?: "plan" | "default";
}): ScheduledTaskUpsertInput {
  return {
    id: input.id,
    title: `Task ${input.id}`,
    prompt: "Run the scheduled maintenance check.",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: input.project ?? projectId,
    threadId: input.threadId,
    workspaceStrategy: { type: "root" },
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    createdBy: "agent",
    creationSource: "mcp",
  };
}

function manualRunInput(input: {
  readonly taskId: ScheduledTaskId;
  readonly key: string;
  readonly unboundThreadId?: ThreadId;
  readonly project?: ProjectId;
  readonly callerRuntimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly callerInteractionMode?: "plan" | "default";
}) {
  return {
    id: input.taskId,
    commandId: CommandId.make(`command:scheduled-run-now:${input.key}`),
    messageId: MessageId.make(`message:scheduled-run-now:${input.taskId}:${input.key}`),
    unboundThreadId:
      input.unboundThreadId ??
      ThreadId.make(`thread:scheduled-run-now:${input.taskId}:${input.key}`),
    projectId: input.project ?? projectId,
    policyCeiling: {
      callerThreadId,
      runtimeMode: input.callerRuntimeMode ?? "full-access",
      interactionMode: input.callerInteractionMode ?? "default",
    },
  } as const;
}

describe("ScheduledTaskService.runNowIdempotent", () => {
  it.layer(makeHarness(), { timeout: "30 seconds" })(
    "real bound and unbound launches return durable accepted runs",
    (it) => {
      it.effect("dispatches through ThreadManagement and ThreadLaunch", () =>
        Effect.gen(function* () {
          const scheduler = yield* ScheduledTasks.ScheduledTaskService;
          const threads = yield* ThreadManagement.ThreadManagementService;
          yield* createThread({ commandId: "command:caller:create", threadId: callerThreadId });
          yield* createThread({ commandId: "command:bound:create", threadId: boundThreadId });

          const boundTaskId = ScheduledTaskId.make("scheduled-task:bound-real");
          yield* scheduler.upsert(taskInput({ id: boundTaskId, threadId: boundThreadId }));
          const bound = yield* scheduler.runNowIdempotent(
            manualRunInput({ taskId: boundTaskId, key: "bound-real" }),
          );
          expect(bound).toMatchObject({
            task: {
              id: boundTaskId,
              enabled: true,
              runCount: 1,
              lastRunStatus: "succeeded",
              nextRunAt: expect.any(String),
            },
            threadId: boundThreadId,
            status: "starting",
            replayed: false,
            receipt: { commandType: "message.dispatch", status: "accepted" },
          });
          const boundProjection = yield* threads.getThreadProjection(boundThreadId);
          expect(
            boundProjection.messages.find((message) => message.id === bound.messageId)?.text,
          ).toBe(
            "[Triggered by schedule task: Task scheduled-task:bound-real]\n\nRun the scheduled maintenance check.",
          );

          const unboundTaskId = ScheduledTaskId.make("scheduled-task:unbound-real");
          const newThreadId = ThreadId.make("thread:scheduled-run-now:unbound-real");
          yield* scheduler.upsert(taskInput({ id: unboundTaskId, threadId: null }));
          const unbound = yield* scheduler.runNowIdempotent(
            manualRunInput({
              taskId: unboundTaskId,
              key: "unbound-real",
              unboundThreadId: newThreadId,
            }),
          );
          expect(unbound).toMatchObject({
            task: { id: unboundTaskId, runCount: 1, lastRunStatus: "succeeded" },
            threadId: newThreadId,
            status: "preparing",
            replayed: false,
            receipt: { commandType: "message.dispatch", status: "accepted" },
          });
          const unboundProjection = yield* threads.getThreadProjection(newThreadId);
          expect(unboundProjection.messages).toHaveLength(1);
          expect(unboundProjection.runs.find((run) => run.id === unbound.runId)?.status).toBe(
            "preparing",
          );
        }),
      );
    },
  );

  it.layer(makeHarness(), { timeout: "30 seconds" })("accepted retry behavior", (it) => {
    it.effect("replays after task deletion and rejects the same key for another task", () =>
      Effect.gen(function* () {
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const orchestrator = yield* OrchestratorV2;
        yield* createThread({ commandId: "command:caller:retry", threadId: callerThreadId });
        yield* createThread({ commandId: "command:bound:retry", threadId: boundThreadId });

        const firstTaskId = ScheduledTaskId.make("scheduled-task:replay-first");
        const firstInput = manualRunInput({ taskId: firstTaskId, key: "accepted-replay" });
        yield* scheduler.upsert(taskInput({ id: firstTaskId, threadId: boundThreadId }));
        const accepted = yield* scheduler.runNowIdempotent(firstInput);
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("command:caller:accepted-replay:downgrade"),
          threadId: callerThreadId,
          runtimeMode: "approval-required",
        });
        yield* scheduler.delete({ id: firstTaskId });
        const replayed = yield* scheduler.runNowIdempotent(firstInput);
        expect(replayed).toEqual({ ...accepted, task: null, replayed: true });
        expect((yield* threads.getThreadProjection(boundThreadId)).messages).toHaveLength(1);

        const otherTaskId = ScheduledTaskId.make("scheduled-task:replay-other");
        yield* scheduler.upsert(taskInput({ id: otherTaskId, threadId: boundThreadId }));
        const conflict = yield* Effect.flip(
          scheduler.runNowIdempotent({
            ...manualRunInput({ taskId: otherTaskId, key: "accepted-replay" }),
            commandId: firstInput.commandId,
          }),
        );
        expect(conflict).toBeInstanceOf(ScheduledTasks.ScheduledTaskManualRunMessageConflictError);
        expect((yield* threads.getThreadProjection(boundThreadId)).messages).toHaveLength(1);
      }),
    );
  });

  it.effect("serializes a manual command from receipt lookup through bookkeeping", () =>
    Effect.gen(function* () {
      const receiptLookupCompleted = yield* Deferred.make<void>();
      const releaseReceiptLookup = yield* Deferred.make<void>();
      const taskId = ScheduledTaskId.make("scheduled-task:concurrent-command");
      const input = manualRunInput({ taskId, key: "concurrent-command" });
      let gated = false;
      const harness = makeHarness({
        mapThreadManagement: (service) => ({
          ...service,
          getCommandReceipt: (commandId) =>
            service.getCommandReceipt(commandId).pipe(
              Effect.flatMap((receipt) => {
                if (gated || commandId !== input.commandId || Option.isSome(receipt)) {
                  return Effect.succeed(receipt);
                }
                gated = true;
                return Deferred.succeed(receiptLookupCompleted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseReceiptLookup)),
                  Effect.as(receipt),
                );
              }),
            ),
        }),
      });

      yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createThread({ commandId: "command:caller:concurrent", threadId: callerThreadId });
        yield* createThread({ commandId: "command:bound:concurrent", threadId: boundThreadId });
        yield* scheduler.upsert(taskInput({ id: taskId, threadId: boundThreadId }));

        const first = yield* scheduler.runNowIdempotent(input).pipe(Effect.forkChild);
        yield* Deferred.await(receiptLookupCompleted);
        const retry = yield* scheduler.runNowIdempotent(input).pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseReceiptLookup, undefined);

        const accepted = yield* Fiber.join(first);
        const replayed = yield* Fiber.join(retry);
        expect(accepted.replayed).toBe(false);
        expect(replayed).toEqual({ ...accepted, task: null, replayed: true });
        expect((yield* threads.getThreadProjection(boundThreadId)).messages).toHaveLength(1);
        expect((yield* scheduler.list()).tasks.find((task) => task.id === taskId)).toMatchObject({
          runCount: 1,
          nextRunAt: accepted.task?.nextRunAt,
        });
      }).pipe(Effect.provide(harness), Effect.scoped);
    }),
  );

  it.effect("rejects concurrent cross-task reuse before mutating the losing task", () =>
    Effect.gen(function* () {
      const receiptLookupCompleted = yield* Deferred.make<void>();
      const releaseReceiptLookup = yield* Deferred.make<void>();
      const firstTaskId = ScheduledTaskId.make("scheduled-task:concurrent-key-first");
      const secondTaskId = ScheduledTaskId.make("scheduled-task:concurrent-key-second");
      const firstInput = manualRunInput({ taskId: firstTaskId, key: "concurrent-cross-task" });
      const secondInput = {
        ...manualRunInput({ taskId: secondTaskId, key: "concurrent-cross-task" }),
        commandId: firstInput.commandId,
      };
      let gated = false;
      const harness = makeHarness({
        mapThreadManagement: (service) => ({
          ...service,
          getCommandReceipt: (commandId) =>
            service.getCommandReceipt(commandId).pipe(
              Effect.flatMap((receipt) => {
                if (gated || commandId !== firstInput.commandId || Option.isSome(receipt)) {
                  return Effect.succeed(receipt);
                }
                gated = true;
                return Deferred.succeed(receiptLookupCompleted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseReceiptLookup)),
                  Effect.as(receipt),
                );
              }),
            ),
        }),
      });

      yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createThread({ commandId: "command:caller:cross-task", threadId: callerThreadId });
        yield* createThread({ commandId: "command:bound:cross-task", threadId: boundThreadId });
        yield* scheduler.upsert(taskInput({ id: firstTaskId, threadId: boundThreadId }));
        yield* scheduler.upsert(taskInput({ id: secondTaskId, threadId: boundThreadId }));

        const first = yield* scheduler.runNowIdempotent(firstInput).pipe(Effect.forkChild);
        yield* Deferred.await(receiptLookupCompleted);
        const second = yield* scheduler.runNowIdempotent(secondInput).pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseReceiptLookup, undefined);

        yield* Fiber.join(first);
        const conflict = yield* Fiber.join(second).pipe(Effect.flip);
        expect(conflict).toBeInstanceOf(ScheduledTasks.ScheduledTaskManualRunMessageConflictError);
        expect((yield* threads.getThreadProjection(boundThreadId)).messages).toHaveLength(1);
        const tasks = (yield* scheduler.list()).tasks;
        expect(tasks.find((task) => task.id === firstTaskId)?.runCount).toBe(1);
        expect(tasks.find((task) => task.id === secondTaskId)?.runCount).toBe(0);
      }).pipe(Effect.provide(harness), Effect.scoped);
    }),
  );

  it.layer(makeHarness(), { timeout: "30 seconds" })("fresh target lifecycle acceptance", (it) => {
    it.effect("rejects when archive wins after the caller preflight", () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createThread({ commandId: "command:caller:archive-race", threadId: callerThreadId });
        yield* createThread({ commandId: "command:target:archive-race", threadId: boundThreadId });
        const preflightCompleted = yield* Deferred.make<void>();
        const allowAcceptance = yield* Deferred.make<void>();

        const send = yield* Effect.gen(function* () {
          const target = yield* threads.getProjectThread({ projectId, threadId: boundThreadId });
          expect(target.thread.archivedAt).toBeNull();
          yield* Deferred.succeed(preflightCompleted, undefined);
          yield* Deferred.await(allowAcceptance);
          return yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:target:archive-race:message"),
            threadId: boundThreadId,
            messageId: MessageId.make("message:target:archive-race"),
            text: "Run after the preflight.",
            attachments: [],
            policyCeiling: {
              callerThreadId,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "mcp",
          });
        }).pipe(Effect.forkChild);

        yield* Deferred.await(preflightCompleted);
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("command:target:archive-race:archive"),
          threadId: boundThreadId,
        });
        yield* Deferred.succeed(allowAcceptance, undefined);
        const failure = yield* Fiber.join(send).pipe(Effect.flip);
        expect(failure._tag).toBe("OrchestratorDispatchError");
        expect((yield* threads.getThreadProjection(boundThreadId)).messages).toHaveLength(0);
      }),
    );
  });

  it.layer(makeHarness({ providerAdapter: null }), { timeout: "30 seconds" })(
    "partial launch failure behavior",
    (it) => {
      it.effect("does not duplicate an unbound thread after provider dispatch rejection", () =>
        Effect.gen(function* () {
          const scheduler = yield* ScheduledTasks.ScheduledTaskService;
          const orchestrator = yield* OrchestratorV2;
          yield* createThread({ commandId: "command:caller:partial", threadId: callerThreadId });
          const taskId = ScheduledTaskId.make("scheduled-task:partial-launch");
          const targetThreadId = ThreadId.make("thread:scheduled-run-now:partial-launch");
          const input = manualRunInput({
            taskId,
            key: "partial-launch",
            unboundThreadId: targetThreadId,
          });
          yield* scheduler.upsert(taskInput({ id: taskId, threadId: null }));

          const firstFailure = yield* Effect.flip(scheduler.runNowIdempotent(input));
          expect(firstFailure._tag).toBe("ScheduledTaskError");
          expect(yield* orchestrator.getThreadShell(targetThreadId)).toMatchObject({
            id: targetThreadId,
            projectId,
          });
          expect((yield* scheduler.list()).tasks.find((task) => task.id === taskId)).toMatchObject({
            runCount: 1,
            lastRunStatus: "failed",
          });

          const retryFailure = yield* Effect.flip(scheduler.runNowIdempotent(input));
          expect(retryFailure._tag).toBe("ScheduledTaskError");
          const shells = (yield* orchestrator.getShellSnapshot()).threads;
          expect(shells).toHaveLength(2);
          expect(shells).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: targetThreadId }),
              expect.objectContaining({ id: callerThreadId }),
            ]),
          );
          expect((yield* scheduler.list()).tasks.find((task) => task.id === taskId)).toMatchObject({
            runCount: 1,
            lastRunStatus: "failed",
          });
        }),
      );
    },
  );

  it.effect("serializes active admission and rejects a caller downgrade before V2 acceptance", () =>
    Effect.gen(function* () {
      const lookupEntered = yield* Deferred.make<void>();
      const allowLookup = yield* Deferred.make<void>();
      let lookupCount = 0;
      const harness = makeHarness({
        getProject: (id) => {
          lookupCount += 1;
          return lookupCount === 1
            ? Deferred.succeed(lookupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowLookup)),
                Effect.as(id === projectId ? Option.some(project) : Option.none()),
              )
            : Effect.succeed(id === projectId ? Option.some(project) : Option.none());
        },
      });

      yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        const orchestrator = yield* OrchestratorV2;
        yield* createThread({ commandId: "command:caller:race", threadId: callerThreadId });
        const taskId = ScheduledTaskId.make("scheduled-task:admission-race");
        const targetThreadId = ThreadId.make("thread:scheduled-run-now:admission-race");
        yield* scheduler.upsert(taskInput({ id: taskId, threadId: null }));
        const firstInput = manualRunInput({
          taskId,
          key: "admission-race-first",
          unboundThreadId: targetThreadId,
        });
        const firstFiber = yield* scheduler.runNowIdempotent(firstInput).pipe(Effect.forkChild);
        yield* Deferred.await(lookupEntered);

        const overlap = yield* Effect.flip(
          scheduler.runNowIdempotent(manualRunInput({ taskId, key: "admission-race-overlap" })),
        );
        expect(overlap).toBeInstanceOf(ScheduledTasks.ScheduledTaskManualRunAlreadyRunningError);

        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("command:caller:race:downgrade"),
          threadId: callerThreadId,
          runtimeMode: "approval-required",
        });
        yield* Deferred.succeed(allowLookup, undefined);
        const failure = yield* Effect.flip(Fiber.join(firstFiber));
        expect(failure._tag).toBe("ScheduledTaskError");
        expect(yield* orchestrator.getThreadShell(targetThreadId)).toBeNull();
        const stored = (yield* scheduler.list()).tasks.find((task) => task.id === taskId);
        expect(stored).toMatchObject({ runCount: 1, lastRunStatus: "failed" });
      }).pipe(Effect.provide(harness), Effect.scoped);
    }),
  );

  it.effect("rejects a manual run while the recurring scheduler owns admission", () =>
    Effect.gen(function* () {
      const lookupEntered = yield* Deferred.make<void>();
      const allowLookup = yield* Deferred.make<void>();
      let lookupCount = 0;
      const harness = makeHarness({
        getProject: (id) => {
          lookupCount += 1;
          return lookupCount === 1
            ? Deferred.succeed(lookupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowLookup)),
                Effect.as(id === projectId ? Option.some(project) : Option.none()),
              )
            : Effect.succeed(id === projectId ? Option.some(project) : Option.none());
        },
      });

      yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        yield* createThread({ commandId: "command:caller:recurring", threadId: callerThreadId });
        const taskId = ScheduledTaskId.make("scheduled-task:recurring-overlap");
        yield* scheduler.upsert(taskInput({ id: taskId, threadId: null }));
        const completed = yield* scheduler.subscribeList().pipe(
          Stream.filter((snapshot) =>
            snapshot.tasks.some(
              (task) =>
                task.id === taskId && task.lastRunStatus === "succeeded" && task.runCount === 1,
            ),
          ),
          Stream.runHead,
          Effect.forkChild,
        );

        yield* TestClock.adjust(Duration.seconds(65));
        yield* Deferred.await(lookupEntered);
        const overlap = yield* Effect.flip(
          scheduler.runNowIdempotent(manualRunInput({ taskId, key: "recurring-overlap-manual" })),
        );
        expect(overlap).toBeInstanceOf(ScheduledTasks.ScheduledTaskManualRunAlreadyRunningError);
        yield* Deferred.succeed(allowLookup, undefined);
        const snapshot = yield* Fiber.join(completed);
        expect(Option.getOrThrow(snapshot)?.tasks.find((task) => task.id === taskId)).toMatchObject(
          {
            lastRunStatus: "succeeded",
            runCount: 1,
          },
        );
      }).pipe(Effect.provide(harness), Effect.scoped);
    }),
  );

  it.effect("does not apply a stale missed-run reschedule after the task is disabled", () =>
    Effect.gen(function* () {
      const firstDispatchEntered = yield* Deferred.make<void>();
      const releaseFirstDispatch = yield* Deferred.make<void>();
      let lookupCount = 0;
      const harness = makeHarness({
        getProject: (id) => {
          lookupCount += 1;
          return lookupCount === 1
            ? Deferred.succeed(firstDispatchEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstDispatch)),
                Effect.as(id === projectId ? Option.some(project) : Option.none()),
              )
            : Effect.succeed(id === projectId ? Option.some(project) : Option.none());
        },
      });

      yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const blockerTaskId = ScheduledTaskId.make("scheduled-task:a-poll-blocker");
        const staleTaskId = ScheduledTaskId.make("scheduled-task:z-stale-fixed-time");
        yield* scheduler.upsert({
          ...taskInput({ id: staleTaskId, threadId: null }),
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
        });
        yield* scheduler.upsert(taskInput({ id: blockerTaskId, threadId: null }));
        const staleDueAt = "1969-12-30T00:00:00.000Z";
        yield* sql`
          UPDATE scheduled_tasks
          SET next_run_at = ${staleDueAt}
          WHERE task_id IN (${blockerTaskId}, ${staleTaskId})
        `;

        const poll = yield* TestClock.adjust(Duration.seconds(5)).pipe(Effect.forkChild);
        yield* Deferred.await(firstDispatchEntered);
        yield* scheduler.setEnabled({ id: staleTaskId, enabled: false });
        yield* Deferred.succeed(releaseFirstDispatch, undefined);
        yield* Fiber.join(poll);

        expect(
          (yield* scheduler.list()).tasks.find((task) => task.id === staleTaskId),
        ).toMatchObject({
          enabled: false,
          nextRunAt: null,
          runCount: 0,
        });
      }).pipe(Effect.provide(harness), Effect.scoped);
    }),
  );

  it.layer(makeHarness(), { timeout: "30 seconds" })("fresh scope and ceiling checks", (it) => {
    it.effect("rejects a higher-mode bound target and a task from another project", () =>
      Effect.gen(function* () {
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        yield* createThread({
          commandId: "command:caller:limited",
          threadId: callerThreadId,
          runtimeMode: "approval-required",
        });
        yield* createThread({ commandId: "command:bound:higher", threadId: boundThreadId });

        const highTaskId = ScheduledTaskId.make("scheduled-task:higher-mode");
        yield* scheduler.upsert(taskInput({ id: highTaskId, threadId: boundThreadId }));
        const ceilingFailure = yield* Effect.flip(
          scheduler.runNowIdempotent(
            manualRunInput({
              taskId: highTaskId,
              key: "higher-mode",
              callerRuntimeMode: "approval-required",
            }),
          ),
        );
        expect(ceilingFailure).toBeInstanceOf(
          ScheduledTasks.ScheduledTaskManualRunRuntimeCeilingError,
        );

        const otherTaskId = ScheduledTaskId.make("scheduled-task:other-project");
        yield* scheduler.upsert(
          taskInput({ id: otherTaskId, threadId: null, project: otherProjectId }),
        );
        const scopeFailure = yield* Effect.flip(
          scheduler.runNowIdempotent(manualRunInput({ taskId: otherTaskId, key: "other-project" })),
        );
        assert.equal(scopeFailure._tag, "ScheduledTaskManualRunTaskScopeError");
      }),
    );
  });
});

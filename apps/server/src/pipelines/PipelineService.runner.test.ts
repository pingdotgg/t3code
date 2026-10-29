import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  PipelineDefinition,
  PipelineError,
  PipelineRun,
  PipelineRunStartInput,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type PipelineRunId,
  type PipelineRunSummary,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import type { ThreadManagementWaitResult } from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PipelineService from "./PipelineService.ts";
import * as PipelineStore from "./PipelineStore.ts";
import { beforeRestoreRef } from "./pipelineWorkspace.ts";

const decodeDefinition = Schema.decodeSync(PipelineDefinition);
const decodeRun = Schema.decodeSync(PipelineRun);
const decodeStart = Schema.decodeSync(PipelineRunStartInput);
const decodeThreadId = Schema.decodeSync(ThreadId);
const decodeCheckpointRef = Schema.decodeSync(CheckpointRef);

const TEST_WORKTREES_DIR = "/t3-test-worktrees";
/** Worktrees the server manages: a folder per repository below its worktrees directory. */
const MANAGED_ROOT = `${TEST_WORKTREES_DIR}/repo`;

const NOW = "2026-10-28T10:00:00.000Z";
const PIPELINE_ID = "pipeline-1";

const step = (id: string, promptTemplate: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Step ${id}`,
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access" as const,
  skills: [],
  promptTemplate,
  pauseBefore: false,
  ...extra,
});

const definition = (steps: ReadonlyArray<ReturnType<typeof step>>) =>
  decodeDefinition({ id: PIPELINE_ID, name: "Review", steps, createdAt: NOW, updatedAt: NOW });

const twoSteps = (extraBuild: Record<string, unknown> = {}) => [
  step("plan", "{{input}}", { skills: ["plan-skill"] }),
  step("build", "Build from: {{previous.output}}", extraBuild),
];

const startInput = (
  commandId: string,
  input = "Fix the bug\nwith details",
  workspaceStrategy: typeof PipelineRunStartInput.Encoded.workspaceStrategy = { type: "root" },
) =>
  decodeStart({
    commandId,
    pipelineId: PIPELINE_ID,
    projectId: "project-1",
    input,
    workspaceStrategy,
  });

type RunStatus = "completed" | "failed" | "interrupted";

interface CannedOutput {
  readonly reply?: string;
  readonly error?: string;
}

/** Mocks for the launch and thread-management seams; every wait is a Deferred the test settles. */
const makeHarness = Effect.gen(function* () {
  const launches = yield* Queue.unbounded<{ input: ThreadLaunchInput; threadId: ThreadId }>();
  const waitsStarted = yield* Queue.unbounded<ThreadId>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const interrupted = yield* Deferred.make<ThreadId>();
  const subscriptions = yield* Queue.unbounded<number>();
  const subscribed = yield* Deferred.make<void>();
  const stopStarted = yield* Queue.unbounded<ThreadId>();
  const stopGate = yield* Deferred.make<void>();
  const idleChecks = yield* Queue.unbounded<ThreadId>();
  const providerEnabled = yield* Ref.make(true);
  const behavior = {
    holdStops: false,
    failFirstSubscription: false,
    failParentCreate: false,
    subscriptionCount: 0,
    worktreeRoot: "/wt",
    restoreFails: false,
  };
  /** Threads whose agent is still stopping: their shell reports an active run. */
  const activeRuns = new Set<ThreadId>();
  const checkpointOps: Array<{ op: "has" | "capture" | "restore"; cwd: string; ref: string }> = [];
  /** Threads whose shell has no workspace, as after a failed worktree setup. */
  const unrecordedWorkspaces = new Set<ThreadId>();
  const deletedThreads = new Set<ThreadId>();
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const waits = new Map<ThreadId, Deferred.Deferred<ThreadManagementWaitResult>>();
  const outputs = new Map<ThreadId, CannedOutput>();

  const runFor = (threadId: ThreadId, status: RunStatus) =>
    ({ id: `run-of:${threadId}`, status }) as unknown as OrchestrationV2Run;

  const waitFor = (threadId: ThreadId) => {
    const existing = waits.get(threadId);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<ThreadManagementWaitResult>();
    waits.set(threadId, created);
    return created;
  };

  /** Settles the thread's next (or current) wait; a later call replaces an already settled one. */
  const settle = Effect.fn("harness.settle")(function* (threadId: ThreadId, status: RunStatus) {
    const run = runFor(threadId, status);
    const result: ThreadManagementWaitResult = { threadId, run, timedOut: false, resultRun: run };
    const current = waitFor(threadId);
    if (yield* Deferred.isDone(current)) {
      const replacement = Deferred.makeUnsafe<ThreadManagementWaitResult>();
      waits.set(threadId, replacement);
      yield* Deferred.succeed(replacement, result);
    } else {
      yield* Deferred.succeed(current, result);
    }
  });

  const recordsFor = (threadId: ThreadId) => {
    const output = outputs.get(threadId) ?? {};
    const runId = `run-of:${threadId}`;
    const turnItems: Array<Record<string, unknown>> = [];
    if (output.reply !== undefined) {
      turnItems.push({
        type: "assistant_message",
        runId,
        ordinal: 1,
        text: output.reply,
        messageId: "message-1",
      });
    }
    if (output.error !== undefined) {
      turnItems.push({ type: "error", runId, ordinal: 3, failure: { message: output.error } });
    }
    const messages =
      output.reply === undefined
        ? []
        : [{ id: "message-1", runId, role: "assistant", text: output.reply }];
    return { runs: [], messages, turnItems };
  };

  const shellFor = (threadId: ThreadId) => {
    const recorded = threadId.startsWith("thread-of:") && !unrecordedWorkspaces.has(threadId);
    return {
      id: threadId,
      branch: recorded ? "feature" : null,
      worktreePath: recorded ? `${behavior.worktreeRoot}/${threadId}` : null,
      activeRunId: activeRuns.has(threadId) ? "run-active" : null,
      deletedAt: deletedThreads.has(threadId) ? "2026-10-28T10:00:00.000Z" : null,
    } as unknown as OrchestrationV2ThreadShell;
  };

  const layer = Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) => {
        const threadId = decodeThreadId(`thread-of:${input.commandId}`);
        return Queue.offer(launches, { input, threadId }).pipe(
          Effect.as({ threadId, projection: {} as never, resumed: false }),
        );
      },
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type === "thread.create" && behavior.failParentCreate) {
            return yield* Effect.fail(new Error("parent boom") as never);
          }
          commands.push(command);
          if (command.type === "thread.stop") {
            yield* Queue.offer(stopStarted, command.threadId);
            if (behavior.holdStops) yield* Deferred.await(stopGate);
          }
          return { sequence: 0, storedEvents: [] };
        }),
      waitForThread: (input) =>
        Queue.offer(waitsStarted, input.threadId).pipe(
          Effect.andThen(Deferred.await(waitFor(input.threadId))),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, input.threadId)),
        ),
      getProjectThreadRecords: (input) => Effect.succeed(recordsFor(input.threadId)) as never,
      // A recovery sweep that reads a parent before the deletion watcher subscribed would wait forever.
      getThreadShell: (threadId) =>
        (threadId.startsWith("parent-") ? Deferred.await(subscribed) : Effect.void).pipe(
          Effect.andThen(
            activeRuns.has(threadId) ? Queue.offer(idleChecks, threadId) : Effect.void,
          ),
          Effect.as(shellFor(threadId)),
        ),
      getCheckpointContext: (threadId) => {
        const { worktreePath } = shellFor(threadId);
        return Effect.succeed({
          runs: [{ id: `run-of:${threadId}`, ordinal: 1, status: "failed" }],
          checkpoints: [],
          checkpointScopes:
            worktreePath === null
              ? []
              : [
                  {
                    id: `scope-of:${threadId}`,
                    runId: `run-of:${threadId}`,
                    kind: "root_run",
                    cwd: worktreePath,
                  },
                ],
        }) as never;
      },
      isProviderInstanceEnabledForProject: () => Ref.get(providerEnabled),
      streamDomainEvents: Stream.unwrap(
        Effect.gen(function* () {
          behavior.subscriptionCount += 1;
          yield* Queue.offer(subscriptions, behavior.subscriptionCount);
          if (behavior.failFirstSubscription && behavior.subscriptionCount === 1) {
            return yield* Effect.fail(new Error("stream boom") as never);
          }
          yield* Deferred.succeed(subscribed, undefined);
          return Stream.fromQueue(events);
        }),
      ),
    }),
    Layer.mock(CheckpointStore.CheckpointStore)({
      hasCheckpointRef: ({ cwd, checkpointRef }) =>
        Effect.sync(() => {
          checkpointOps.push({ op: "has", cwd, ref: checkpointRef });
          return true;
        }),
      captureCheckpoint: ({ cwd, checkpointRef }) =>
        Effect.sync(() => {
          checkpointOps.push({ op: "capture", cwd, ref: checkpointRef });
        }),
      restoreCheckpoint: ({ cwd, checkpointRef }) =>
        behavior.restoreFails
          ? Effect.fail(new Error("git boom") as never)
          : Effect.sync(() => {
              checkpointOps.push({ op: "restore", cwd, ref: checkpointRef });
              return true;
            }),
    }),
    // Only the worktrees directory is read, to tell managed worktrees from other folders.
    Layer.succeed(ServerConfig.ServerConfig, {
      worktreesDir: TEST_WORKTREES_DIR,
    } as ServerConfig.ServerConfig["Service"]),
    IdAllocator.layer,
    NodeCrypto.layer,
    NodeServices.layer,
    ServerSettings.layerTest(),
  );

  return {
    layer,
    launches,
    waitsStarted,
    events,
    interrupted,
    providerEnabled,
    commands,
    outputs,
    settle,
    subscriptions,
    stopStarted,
    stopGate,
    idleChecks,
    activeRuns,
    checkpointOps,
    behavior,
    unrecordedWorkspaces,
    deletedThreads,
  };
});

const baseLayer = PipelineStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

/** Runs a test body against a fresh harness and the real service over an in-memory database. */
const withService = <A, E>(
  body: (
    harness: Effect.Success<typeof makeHarness>,
    service: PipelineService.PipelineService["Service"],
    store: PipelineStore.PipelineStore["Service"],
  ) => Effect.Effect<A, E, PipelineStore.PipelineStore>,
  seed?: (
    store: PipelineStore.PipelineStore["Service"],
    harness: Effect.Success<typeof makeHarness>,
  ) => Effect.Effect<void, PipelineError>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const store = yield* PipelineStore.PipelineStore;
    yield* store.insertDefinition(definition(twoSteps()));
    if (seed !== undefined) yield* seed(store, harness);
    return yield* Effect.gen(function* () {
      const service = yield* PipelineService.PipelineService;
      return yield* body(harness, service, store);
    }).pipe(
      Effect.provide(
        PipelineService.layer.pipe(Layer.provide(harness.layer), Layer.provide(baseLayer)),
      ),
    );
  }).pipe(Effect.provide(baseLayer));

const awaitRun = (
  service: PipelineService.PipelineService["Service"],
  runId: PipelineRunId,
  predicate: (run: PipelineRun) => boolean,
) =>
  service.subscribeRun({ runId }).pipe(
    Stream.filter((result) => predicate(result.run)),
    Stream.runHead,
    Effect.map((head) => Option.getOrThrow(head).run),
  );

const commandOfType = <T extends OrchestrationV2ServerCommand["type"]>(
  commands: ReadonlyArray<OrchestrationV2ServerCommand>,
  type: T,
) =>
  commands.filter(
    (command): command is Extract<OrchestrationV2ServerCommand, { readonly type: T }> =>
      command.type === type,
  );

it.effect("start creates the parent thread and launches step 0 with the skill prefix", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-1"));
      assert.strictEqual(run.id, "pipeline-run:cmd-1");
      assert.strictEqual(run.status, "running");

      const launched = yield* Queue.take(harness.launches);
      assert.strictEqual(launched.input.commandId, `pipeline-run:${run.id}:plan:1`);
      assert.strictEqual(launched.input.title, "Review · Step plan");
      assert.strictEqual(
        launched.input.initialMessage?.text,
        "$plan-skill\n\nFix the bug\nwith details",
      );
      assert.strictEqual(launched.input.pipeline?.stepId, "plan");
      assert.strictEqual(launched.input.interactionMode, "default");
      assert.strictEqual(launched.input.pipeline?.runId, run.id);
      assert.deepStrictEqual(launched.input.workspaceStrategy, { type: "root" });

      const [parent] = commandOfType(harness.commands, "thread.create");
      assert.strictEqual(parent?.commandId, `pipeline-run:${run.id}:parent`);
      assert.strictEqual(parent?.threadId, run.parentThreadId);
      assert.strictEqual(parent?.title, "Review: Fix the bug");
      assert.strictEqual(parent?.interactionMode, "default");
      assert.deepStrictEqual(parent?.pipeline, { runId: run.id, stepId: null });

      // A replayed commandId resolves to the same run and creates nothing more.
      const replay = yield* service.start(startInput("cmd-1"));
      assert.strictEqual(replay.run.id, run.id);
      assert.strictEqual(commandOfType(harness.commands, "thread.create").length, 1);
    }),
  ),
);

it.effect("a finished step feeds the next one in its workspace, and the last step completes", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-2"));
      const first = yield* Queue.take(harness.launches);
      harness.outputs.set(first.threadId, { reply: "first reply" });
      yield* harness.settle(first.threadId, "completed");

      const second = yield* Queue.take(harness.launches);
      assert.strictEqual(second.input.commandId, `pipeline-run:${run.id}:build:1`);
      assert.strictEqual(second.input.initialMessage?.text, "Build from: first reply");
      assert.deepStrictEqual(second.input.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: `/wt/${first.threadId}`,
        branch: "feature",
      });
      const [sync] = commandOfType(harness.commands, "thread.metadata.update");
      assert.strictEqual(sync?.threadId, run.parentThreadId);
      assert.strictEqual(sync?.worktreePath, `/wt/${first.threadId}`);

      harness.outputs.set(second.threadId, { reply: "done" });
      yield* harness.settle(second.threadId, "completed");
      const finished = yield* awaitRun(
        service,
        run.id,
        (current) => current.status === "completed",
      );
      assert.isNotNull(finished.completedAt);
      assert.deepStrictEqual(
        finished.steps.map((current) => [current.status, current.outputPreview]),
        [
          ["completed", "first reply"],
          ["completed", "done"],
        ],
      );
    }),
  ),
);

it.effect("pauseBefore pauses the run and Continue re-captures the feeding output", () =>
  withService(
    Effect.fn(function* (harness, service, store) {
      yield* store.updateDefinition(definition(twoSteps({ pauseBefore: true })));
      const { run } = yield* service.start(startInput("cmd-3"));
      const first = yield* Queue.take(harness.launches);
      harness.outputs.set(first.threadId, { reply: "first draft" });
      yield* harness.settle(first.threadId, "completed");

      const paused = yield* awaitRun(service, run.id, (current) => current.status === "paused");
      assert.strictEqual(paused.pauseReason, "awaiting_continue");
      assert.strictEqual(paused.currentStepIndex, 1);
      assert.strictEqual(yield* Queue.size(harness.launches), 0);

      // The user refines step 0 in its thread, then continues.
      harness.outputs.set(first.threadId, { reply: "refined draft" });
      yield* harness.settle(first.threadId, "completed");
      yield* service.continueRun({ runId: run.id, stepIndex: 1 });
      const second = yield* Queue.take(harness.launches);
      assert.strictEqual(second.input.initialMessage?.text, "Build from: refined draft");
    }),
  ),
);

it.effect("a failed step pauses; retry relaunches, skip advances, stale indexes are rejected", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-4"));
      const first = yield* Queue.take(harness.launches);
      harness.outputs.set(first.threadId, { error: "boom" });
      yield* harness.settle(first.threadId, "failed");
      const failed = yield* awaitRun(service, run.id, (current) => current.status === "paused");
      assert.strictEqual(failed.pauseReason, "step_failed");
      assert.strictEqual(failed.error, "boom");
      assert.strictEqual(failed.steps[0]?.status, "failed");
      assert.strictEqual(failed.steps[0]?.error, "boom");

      const stale = yield* Effect.flip(service.retryStep({ runId: run.id, stepIndex: 1 }));
      assert.instanceOf(stale, PipelineError);

      yield* service.retryStep({ runId: run.id, stepIndex: 0 });
      const retried = yield* Queue.take(harness.launches);
      assert.strictEqual(retried.input.commandId, `pipeline-run:${run.id}:plan:2`);
      assert.strictEqual(retried.input.title, "Review · Step plan (attempt 2)");
      // The retry joins the first attempt's workspace instead of creating it again.
      assert.deepStrictEqual(retried.input.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: `/wt/${first.threadId}`,
        branch: "feature",
      });

      harness.outputs.set(retried.threadId, { error: "boom again" });
      yield* harness.settle(retried.threadId, "failed");
      yield* awaitRun(service, run.id, (current) => current.steps[0]?.error === "boom again");
      const skipped = yield* service.skipStep({ runId: run.id, stepIndex: 0 });
      assert.strictEqual(skipped.run.steps[0]?.status, "skipped");
      assert.strictEqual(skipped.run.currentStepIndex, 1);

      const next = yield* Queue.take(harness.launches);
      assert.strictEqual(next.input.commandId, `pipeline-run:${run.id}:build:1`);
      assert.strictEqual(next.input.initialMessage?.text, "Build from: ");
      const outdated = yield* Effect.flip(service.skipStep({ runId: run.id, stepIndex: 0 }));
      assert.instanceOf(outdated, PipelineError);
    }),
  ),
);

it.effect("an interrupted result run pauses with step_stopped", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-5"));
      const first = yield* Queue.take(harness.launches);
      yield* harness.settle(first.threadId, "interrupted");
      const paused = yield* awaitRun(service, run.id, (current) => current.status === "paused");
      assert.strictEqual(paused.pauseReason, "step_stopped");
      assert.strictEqual(paused.steps[0]?.status, "stopped");
    }),
  ),
);

it.effect("cancel stops the child and the driver, and retry resumes from cancelled", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-6"));
      const first = yield* Queue.take(harness.launches);
      // The driver is now parked in the wait.
      assert.strictEqual(yield* Queue.take(harness.waitsStarted), first.threadId);

      const cancelled = yield* service.cancel({ runId: run.id });
      assert.strictEqual(cancelled.run.status, "cancelled");
      assert.strictEqual(cancelled.run.steps[0]?.status, "cancelled");
      assert.strictEqual(yield* Deferred.await(harness.interrupted), first.threadId);
      const [stop] = commandOfType(harness.commands, "thread.stop");
      assert.strictEqual(stop?.commandId, `pipeline-run:${run.id}:cancel:plan:1`);
      assert.strictEqual(stop?.threadId, first.threadId);

      yield* service.retryStep({ runId: run.id, stepIndex: 0 });
      const retried = yield* Queue.take(harness.launches);
      assert.strictEqual(retried.input.commandId, `pipeline-run:${run.id}:plan:2`);
      const resumed = yield* service.getRun(run.id);
      assert.strictEqual(resumed.status, "running");
    }),
  ),
);

const seedRun = (
  store: PipelineStore.PipelineStore["Service"],
  id: string,
  parent: string,
  stepPatch?: Parameters<PipelineStore.PipelineStore["Service"]["updateStep"]>[2],
) => {
  const { steps: _steps, ...run } = decodeRun({
    id,
    pipelineId: PIPELINE_ID,
    definition: { name: "Review", steps: twoSteps() },
    projectId: "project-1",
    parentThreadId: parent,
    input: "Fix",
    workspaceStrategy: { type: "root" },
    status: "running",
    pauseReason: null,
    error: null,
    currentStepIndex: 0,
    steps: [],
    createdBy: "user",
    creationSource: "web",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  });
  return store
    .insertRunWithSteps(run, [
      { index: 0, stepId: "plan" as never, pauseBefore: false },
      { index: 1, stepId: "build" as never, pauseBefore: false },
    ])
    .pipe(
      Effect.andThen(
        stepPatch === undefined ? Effect.void : store.updateStep(run.id, 0, stepPatch),
      ),
    );
};

it.effect("startup recovery re-waits running steps and relaunches unlaunched ones", () => {
  return withService(
    Effect.fn(function* (harness) {
      // Run "a" waits on its existing child; "b" never launched; "c" stopped between write and launch.
      const launched = [yield* Queue.take(harness.launches), yield* Queue.take(harness.launches)];
      assert.sameMembers(
        launched.map((entry) => entry.input.commandId),
        ["pipeline-run:run-b:plan:1", "pipeline-run:run-c:plan:1"],
      );
      // The interrupted launch resumes from what its running write saved, not from a rebuild.
      const resumed = launched.find((entry) => entry.input.commandId.includes("run-c"));
      assert.strictEqual(resumed?.input.initialMessage?.text, "saved prompt");
      assert.deepStrictEqual(resumed?.input.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: "/saved/wt",
      });
      const waiting = [
        yield* Queue.take(harness.waitsStarted),
        yield* Queue.take(harness.waitsStarted),
        yield* Queue.take(harness.waitsStarted),
      ];
      assert.include(waiting, decodeThreadId("child-a"));
    }),
    (store) =>
      seedRun(store, "run-a", "parent-a", {
        status: "running",
        attempt: 1,
        childThreadId: decodeThreadId("child-a"),
      }).pipe(
        Effect.andThen(seedRun(store, "run-b", "parent-b")),
        Effect.andThen(
          seedRun(store, "run-c", "parent-c", {
            status: "running",
            attempt: 1,
            prompt: "saved prompt",
            workspaceStrategy: { type: "existing_worktree", worktreePath: "/saved/wt" },
          }),
        ),
      ),
  );
});

it.effect(
  "start clamps step runtime modes to the caller's limit and names unavailable providers",
  () =>
    withService(
      Effect.fn(function* (harness, service) {
        const { run } = yield* service.start(startInput("cmd-9"), {
          createdBy: "agent",
          modeLimit: { runtimeMode: "approval-required", interactionMode: "plan" },
        });
        assert.deepStrictEqual(
          run.definition.steps.map((current) => current.runtimeMode),
          ["approval-required", "approval-required"],
        );
        assert.strictEqual(run.createdBy, "agent");
        const launched = yield* Queue.take(harness.launches);
        assert.strictEqual(launched.input.runtimeMode, "approval-required");
        assert.strictEqual(launched.input.interactionMode, "default");

        yield* Ref.set(harness.providerEnabled, false);
        const refused = yield* Effect.flip(service.start(startInput("cmd-9b")));
        assert.include(refused.message, '"Step plan" (codex)');
        assert.include(refused.message, '"Step build" (codex)');
      }),
    ),
);

it.effect("deleting the parent thread cancels the run", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-10"));
      const first = yield* Queue.take(harness.launches);
      // The driver is parked in the wait before the delete lands.
      yield* Queue.take(harness.waitsStarted);
      yield* Queue.offer(harness.events, {
        type: "thread.deleted",
        threadId: run.parentThreadId,
      } as unknown as OrchestrationV2DomainEvent);
      const cancelled = yield* awaitRun(
        service,
        run.id,
        (current) => current.status === "cancelled",
      );
      assert.strictEqual(cancelled.steps[0]?.status, "cancelled");
      assert.strictEqual(yield* Deferred.await(harness.interrupted), first.threadId);
    }),
  ),
);

it.effect("a step joins an earlier thread's workspace only when that thread recorded one", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const worktree = { type: "worktree", baseRef: "main" } as const;
      const { run } = yield* service.start(startInput("cmd-11", undefined, worktree));
      const first = yield* Queue.take(harness.launches);
      assert.deepStrictEqual(first.input.workspaceStrategy, worktree);
      // The worktree setup failed, so the thread has no path; the root checkout is not a substitute.
      harness.unrecordedWorkspaces.add(first.threadId);
      yield* harness.settle(first.threadId, "failed");
      yield* awaitRun(service, run.id, (current) => current.status === "paused");

      yield* service.retryStep({ runId: run.id, stepIndex: 0 });
      const retried = yield* Queue.take(harness.launches);
      assert.deepStrictEqual(retried.input.workspaceStrategy, worktree);
      harness.unrecordedWorkspaces.add(retried.threadId);
      yield* harness.settle(retried.threadId, "failed");
      yield* awaitRun(service, run.id, (current) => current.status === "paused");

      yield* service.skipStep({ runId: run.id, stepIndex: 0 });
      const next = yield* Queue.take(harness.launches);
      assert.deepStrictEqual(next.input.workspaceStrategy, worktree);
    }),
  ),
);

it.effect("a completed step without an answer feeds an empty string to the next prompt", () =>
  withService(
    Effect.fn(function* (harness, service) {
      yield* service.start(startInput("cmd-12"));
      const first = yield* Queue.take(harness.launches);
      yield* harness.settle(first.threadId, "completed");
      const second = yield* Queue.take(harness.launches);
      assert.strictEqual(second.input.initialMessage?.text, "Build from: ");
    }),
  ),
);

it.effect("retry and skip stop the old thread and are refused without a parent thread", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-13"));
      const first = yield* Queue.take(harness.launches);
      yield* harness.settle(first.threadId, "failed");
      yield* awaitRun(service, run.id, (current) => current.status === "paused");

      harness.deletedThreads.add(run.parentThreadId);
      for (const action of [service.retryStep, service.skipStep]) {
        const refused = yield* Effect.flip(action({ runId: run.id, stepIndex: 0 }));
        assert.include(refused.message, "parent thread no longer exists");
      }
      assert.strictEqual((yield* service.getRun(run.id)).status, "paused");
      assert.strictEqual(commandOfType(harness.commands, "thread.stop").length, 0);
      harness.deletedThreads.delete(run.parentThreadId);

      yield* service.retryStep({ runId: run.id, stepIndex: 0 });
      const retried = yield* Queue.take(harness.launches);
      yield* harness.settle(retried.threadId, "failed");
      yield* awaitRun(service, run.id, (current) => current.steps[0]?.attempt === 2);
      yield* awaitRun(service, run.id, (current) => current.status === "paused");
      yield* service.skipStep({ runId: run.id, stepIndex: 0 });
      assert.deepStrictEqual(
        commandOfType(harness.commands, "thread.stop").map((stop) => [
          stop.commandId,
          stop.threadId,
        ]),
        [
          [`pipeline-run:${run.id}:retry:plan:1`, first.threadId],
          [`pipeline-run:${run.id}:skip:plan:2`, retried.threadId],
        ],
      );
    }),
  ),
);

it.effect("an interrupted retry still stops the old thread and relaunches", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-14"));
      const first = yield* Queue.take(harness.launches);
      yield* harness.settle(first.threadId, "failed");
      yield* awaitRun(service, run.id, (current) => current.status === "paused");

      harness.behavior.holdStops = true;
      const retrying = yield* Effect.forkChild(service.retryStep({ runId: run.id, stepIndex: 0 }));
      assert.strictEqual(yield* Queue.take(harness.stopStarted), first.threadId);
      // A client disconnect lands in the middle of the action.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(retrying));
      yield* Deferred.succeed(harness.stopGate, undefined);
      yield* Fiber.join(interrupting);
      const retried = yield* Queue.take(harness.launches);
      assert.strictEqual(retried.input.commandId, `pipeline-run:${run.id}:plan:2`);
    }),
  ),
);

it.effect("only steps after the current one can change their pause gate", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-15"));
      yield* Queue.take(harness.launches);
      const [current, later] = run.steps;
      const refused = yield* Effect.flip(
        service.setStepPauseBefore({ runId: run.id, stepId: current!.stepId, pauseBefore: true }),
      );
      assert.include(refused.message, "after the current one");
      const updated = yield* service.setStepPauseBefore({
        runId: run.id,
        stepId: later!.stepId,
        pauseBefore: true,
      });
      assert.isTrue(updated.run.steps[1]?.pauseBefore);
    }),
  ),
);

it.effect("start refuses a saved definition that today's rules would reject", () =>
  withService(
    Effect.fn(function* (_harness, service, store) {
      yield* store.updateDefinition(
        definition([step("plan", "{{steps.build.output}}"), step("build", "x")]),
      );
      const refused = yield* Effect.flip(service.start(startInput("cmd-16")));
      assert.include(refused.message, "does not run before");
      assert.include(refused.message, '"Review"');
    }),
  ),
);

it.effect("a start replay resumes a run that has no driver and repeats a failed start", () =>
  withService(
    Effect.fn(function* (harness, service, store) {
      yield* seedRun(store, "pipeline-run:cmd-17", "parent-replay");
      // The run row exists but the process died before it got a parent or a driver.
      yield* service.start(startInput("cmd-17"));
      const launched = yield* Queue.take(harness.launches);
      assert.strictEqual(launched.input.commandId, "pipeline-run:pipeline-run:cmd-17:plan:1");
      assert.strictEqual(commandOfType(harness.commands, "thread.create").length, 1);

      harness.behavior.failParentCreate = true;
      const failed = yield* Effect.flip(service.start(startInput("cmd-18")));
      assert.strictEqual(failed.message, "parent boom");
      const replayed = yield* Effect.flip(service.start(startInput("cmd-18")));
      assert.strictEqual(replayed.message, "parent boom");
    }),
  ),
);

it.effect("pipelineRuns live stream lists running and paused runs and drops finished ones", () =>
  withService(
    Effect.fn(function* (harness, service, store) {
      yield* store.updateDefinition(definition(twoSteps({ pauseBefore: true })));
      const awaitLive = (predicate: (runs: ReadonlyArray<PipelineRunSummary>) => boolean) =>
        service.subscribeLiveRuns().pipe(
          Stream.filter((result) => predicate(result.runs)),
          Stream.runHead,
          Effect.map((head) => Option.getOrThrow(head).runs),
        );

      const { run } = yield* service.start(startInput("cmd-19"));
      const [started] = yield* awaitLive((runs) => runs.length === 1);
      assert.strictEqual(started?.id, run.id);
      assert.strictEqual(started?.name, "Review");
      assert.strictEqual(started?.parentThreadId, run.parentThreadId);
      assert.deepStrictEqual(
        started?.steps.map((entry) => [entry.stepId, entry.name]),
        [
          ["plan", "Step plan"],
          ["build", "Step build"],
        ],
      );

      const first = yield* Queue.take(harness.launches);
      yield* harness.settle(first.threadId, "completed");
      const [paused] = yield* awaitLive((runs) => runs[0]?.status === "paused");
      assert.strictEqual(paused?.pauseReason, "awaiting_continue");

      yield* service.cancel({ runId: run.id });
      assert.deepStrictEqual(yield* awaitLive((runs) => runs.length === 0), []);

      const second = yield* service.start(startInput("cmd-20"));
      const firstOfSecond = yield* Queue.take(harness.launches);
      yield* harness.settle(firstOfSecond.threadId, "completed");
      yield* awaitRun(service, second.run.id, (current) => current.status === "paused");
      yield* service.continueRun({ runId: second.run.id, stepIndex: 1 });
      const last = yield* Queue.take(harness.launches);
      yield* harness.settle(last.threadId, "completed");
      assert.deepStrictEqual(yield* awaitLive((runs) => runs.length === 0), []);
    }),
  ),
);

it.effect("the deletion watcher resubscribes after its stream fails", () =>
  withService(
    Effect.fn(function* (harness, service) {
      const { run } = yield* service.start(startInput("cmd-21"));
      yield* Queue.take(harness.launches);
      assert.strictEqual(yield* Queue.take(harness.subscriptions), 1);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Queue.take(harness.subscriptions), 2);
      yield* Queue.offer(harness.events, {
        type: "thread.deleted",
        threadId: run.parentThreadId,
      } as unknown as OrchestrationV2DomainEvent);
      yield* awaitRun(service, run.id, (current) => current.status === "cancelled");
    }),
    (_store, harness) =>
      Effect.sync(() => {
        harness.behavior.failFirstSubscription = true;
      }),
  ),
);

it.effect(
  "a restore-retry puts back the first attempt's starting files after saving the failed ones",
  () =>
    withService(
      Effect.fn(function* (harness, service, store) {
        harness.behavior.worktreeRoot = MANAGED_ROOT;
        const { run } = yield* service.start(startInput("cmd-22"));
        const first = yield* Queue.take(harness.launches);
        yield* harness.settle(first.threadId, "failed");
        const failed = yield* awaitRun(service, run.id, (current) => current.status === "paused");
        assert.isTrue(failed.steps[0]?.canRestoreWorkspace);
        const start = yield* store.getStepStartCheckpoint(run.id, 0);
        assert.strictEqual(start?.cwd, `${MANAGED_ROOT}/${first.threadId}`);
        assert.match(start?.ref ?? "", /^refs\/t3\/orchestration-v2\/checkpoints\/.+\/ordinal\/0$/);

        yield* service.retryStep({ runId: run.id, stepIndex: 0, restoreWorkspace: true });
        assert.deepStrictEqual(
          harness.checkpointOps.filter((entry) => entry.op !== "has"),
          [
            { op: "capture", cwd: start!.cwd, ref: beforeRestoreRef(run.id, 0, 1) },
            { op: "restore", cwd: start!.cwd, ref: start!.ref },
          ],
        );
        const retried = yield* Queue.take(harness.launches);
        assert.strictEqual(retried.input.commandId, `pipeline-run:${run.id}:plan:2`);

        // A later attempt's baseline holds the failed attempt's leftovers, so it is never recorded.
        const checked = harness.checkpointOps.length;
        yield* harness.settle(retried.threadId, "failed");
        yield* awaitRun(
          service,
          run.id,
          (current) => current.steps[0]?.attempt === 2 && current.status === "paused",
        );
        assert.strictEqual(harness.checkpointOps.length, checked);
        assert.deepStrictEqual(yield* store.getStepStartCheckpoint(run.id, 0), start);
      }),
    ),
);

it.effect(
  "a restore never touches a workspace outside the managed worktrees; a plain retry restores nothing",
  () =>
    withService(
      Effect.fn(function* (harness, service, store) {
        const { run } = yield* service.start(startInput("cmd-23"));
        const first = yield* Queue.take(harness.launches);
        yield* harness.settle(first.threadId, "failed");
        const failed = yield* awaitRun(service, run.id, (current) => current.status === "paused");
        // The root checkout is not recorded as restorable.
        assert.isFalse(failed.steps[0]?.canRestoreWorkspace);
        const unsaved = yield* Effect.flip(
          service.retryStep({ runId: run.id, stepIndex: 0, restoreWorkspace: true }),
        );
        assert.include(unsaved.message, "were not saved");

        // Even a stored snapshot is refused when its folder is not a managed worktree.
        const ref = decodeCheckpointRef("refs/t3/orchestration-v2/checkpoints/x/ordinal/0");
        yield* store.updateStep(run.id, 0, { startCheckpoint: { cwd: "/projects/app", ref } });
        const refused = yield* Effect.flip(
          service.retryStep({ runId: run.id, stepIndex: 0, restoreWorkspace: true }),
        );
        assert.include(refused.message, "did not run in a T3 Code worktree");
        assert.deepStrictEqual(harness.checkpointOps, []);
        const unchanged = yield* service.getRun(run.id);
        assert.strictEqual(unchanged.status, "paused");
        assert.strictEqual(unchanged.steps[0]?.status, "failed");
        assert.strictEqual(unchanged.steps[0]?.attempt, 1);
        assert.strictEqual(yield* Queue.size(harness.launches), 0);

        yield* service.retryStep({ runId: run.id, stepIndex: 0 });
        const retried = yield* Queue.take(harness.launches);
        assert.strictEqual(retried.input.commandId, `pipeline-run:${run.id}:plan:2`);
        assert.deepStrictEqual(harness.checkpointOps, []);
      }),
    ),
);

it.effect("a failed restore or an agent that is still stopping leaves the run paused", () =>
  withService(
    Effect.fn(function* (harness, service) {
      harness.behavior.worktreeRoot = MANAGED_ROOT;
      const { run } = yield* service.start(startInput("cmd-24"));
      const first = yield* Queue.take(harness.launches);
      yield* harness.settle(first.threadId, "failed");
      yield* awaitRun(service, run.id, (current) => current.status === "paused");
      const assertUnchanged = Effect.gen(function* () {
        const current = yield* service.getRun(run.id);
        assert.strictEqual(current.status, "paused");
        assert.strictEqual(current.steps[0]?.status, "failed");
        assert.strictEqual(current.steps[0]?.attempt, 1);
        assert.strictEqual(yield* Queue.size(harness.launches), 0);
      });

      harness.behavior.restoreFails = true;
      const failedRestore = yield* Effect.flip(
        service.retryStep({ runId: run.id, stepIndex: 0, restoreWorkspace: true }),
      );
      assert.include(failedRestore.message, "Could not restore the step's starting files");
      // The failed files were saved before the restore was attempted.
      assert.deepStrictEqual(
        harness.checkpointOps.filter((entry) => entry.op !== "has").map((entry) => entry.op),
        ["capture"],
      );
      yield* assertUnchanged;

      harness.behavior.restoreFails = false;
      harness.activeRuns.add(first.threadId);
      const operations = harness.checkpointOps.length;
      const retrying = yield* Effect.forkChild(
        Effect.flip(service.retryStep({ runId: run.id, stepIndex: 0, restoreWorkspace: true })),
      );
      yield* Queue.take(harness.idleChecks);
      yield* TestClock.adjust("20 seconds");
      const stopping = yield* Fiber.join(retrying);
      assert.include(stopping.message, "still stopping");
      assert.strictEqual(harness.checkpointOps.length, operations);
      yield* assertUnchanged;
    }),
  ),
);

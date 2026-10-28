import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
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
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import type { ThreadManagementWaitResult } from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PipelineService from "./PipelineService.ts";
import * as PipelineStore from "./PipelineStore.ts";

const decodeDefinition = Schema.decodeSync(PipelineDefinition);
const decodeRun = Schema.decodeSync(PipelineRun);
const decodeStart = Schema.decodeSync(PipelineRunStartInput);
const decodeThreadId = Schema.decodeSync(ThreadId);

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

const startInput = (commandId: string, input = "Fix the bug\nwith details") =>
  decodeStart({
    commandId,
    pipelineId: PIPELINE_ID,
    projectId: "project-1",
    input,
    workspaceStrategy: { type: "root" },
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
  const providerEnabled = yield* Ref.make(true);
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

  const shellFor = (threadId: ThreadId) =>
    ({
      id: threadId,
      branch: threadId.startsWith("thread-of:") ? "feature" : null,
      worktreePath: threadId.startsWith("thread-of:") ? `/wt/${threadId}` : null,
      deletedAt: null,
    }) as unknown as OrchestrationV2ThreadShell;

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
        Effect.sync(() => {
          commands.push(command);
          return { sequence: 0, storedEvents: [] };
        }),
      waitForThread: (input) =>
        Queue.offer(waitsStarted, input.threadId).pipe(
          Effect.andThen(Deferred.await(waitFor(input.threadId))),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, input.threadId)),
        ),
      getProjectThreadRecords: (input) => Effect.succeed(recordsFor(input.threadId)) as never,
      getThreadShell: (threadId) => Effect.succeed(shellFor(threadId)),
      isProviderInstanceEnabledForProject: () => Ref.get(providerEnabled),
      streamDomainEvents: Stream.fromQueue(events),
    }),
    IdAllocator.layer,
    NodeCrypto.layer,
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
  };
});

const baseLayer = PipelineStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

/** Runs a test body against a fresh harness and the real service over an in-memory database. */
const withService = <A, E>(
  body: (
    harness: Effect.Success<typeof makeHarness>,
    service: PipelineService.PipelineService["Service"],
    store: PipelineStore.PipelineStoreShape,
  ) => Effect.Effect<A, E, PipelineStore.PipelineStore>,
  seed?: (
    store: PipelineStore.PipelineStoreShape,
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

it.effect("startup recovery re-waits running steps and relaunches unlaunched ones", () => {
  const seedRun = (
    store: PipelineStore.PipelineStoreShape,
    id: string,
    parent: string,
    stepPatch?: Parameters<PipelineStore.PipelineStoreShape["updateStep"]>[2],
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
  return withService(
    Effect.fn(function* (harness) {
      // Run "a" waits on its existing child; "b" never launched; "c" stopped between write and launch.
      const launched = [yield* Queue.take(harness.launches), yield* Queue.take(harness.launches)];
      assert.sameMembers(
        launched.map((entry) => entry.input.commandId),
        ["pipeline-run:run-b:plan:1", "pipeline-run:run-c:plan:1"],
      );
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
        Effect.andThen(seedRun(store, "run-c", "parent-c", { status: "running", attempt: 1 })),
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

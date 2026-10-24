import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as CommandWatchReactor from "./CommandWatchReactor.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay where the test puts them.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "command-watch" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(NodeServices.layer),
);

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: 0 as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

/** A process runner that answers with `next()` and records each run. */
const fakeRunner = (next: () => ProcessRunner.ProcessRunOutput) => {
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const layer = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return next();
      }),
  });
  return { calls, layer };
};

const createThread = (
  threadId: ThreadId,
  modes: {
    readonly runtimeMode?: "full-access" | "approval-required";
    readonly interactionMode?: "default" | "plan";
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:command-watch"),
      title: threadId,
      modelSelection,
      runtimeMode: modes.runtimeMode ?? "full-access",
      interactionMode: modes.interactionMode ?? "default",
      branch: null,
      worktreePath: process.cwd(),
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Starts a run and marks it running, as an agent calling a tool would be. */
const startRun = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:${text}:running`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    return run.id;
  });

const finishRuns = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    for (const run of (yield* orchestrator.getThreadProjection(threadId)).runs) {
      if (run.status === "completed") continue;
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:${run.id}:completed`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
    }
  });

const startWatch = (threadId: ThreadId, callerRunId: RunId, watchId: string, command: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.command-watch.start",
      commandId: CommandId.make(`watch:${threadId}:${watchId}:${command}`),
      threadId,
      callerRunId,
      watchId,
      command,
      label: `label ${watchId}`,
      everyMinutes: 10,
    });
  });

const watchesOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return (projection.thread.commandWatches ?? []).map((watch) => watch.id);
  });

it.effect("starts, deduplicates, limits and stops command watches", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:command-watch-basics");
    yield* createThread(threadId);
    const runId = yield* startRun(threadId, "work");

    yield* startWatch(threadId, runId, "command-watch:a", "echo a");
    const duplicate = yield* startWatch(threadId, runId, "command-watch:dup", "echo a");
    assert.lengthOf(duplicate.storedEvents, 0);
    for (const name of ["b", "c", "d", "e"]) {
      yield* startWatch(threadId, runId, `command-watch:${name}`, `echo ${name}`);
    }
    // A duplicate at the limit is still the existing watch, not a refusal.
    assert.lengthOf(
      (yield* startWatch(threadId, runId, "command-watch:dup2", "echo a")).storedEvents,
      0,
    );
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(startWatch(threadId, runId, "command-watch:f", "echo f"))),
    );
    assert.deepEqual(yield* watchesOf(threadId), [
      "command-watch:a",
      "command-watch:b",
      "command-watch:c",
      "command-watch:d",
      "command-watch:e",
    ]);

    yield* orchestrator.dispatch({
      type: "thread.command-watch.stop",
      commandId: CommandId.make("stop-one"),
      threadId,
      watchId: "command-watch:b",
    });
    assert.notInclude(yield* watchesOf(threadId), "command-watch:b");
    yield* orchestrator.dispatch({
      type: "thread.command-watch.stop",
      commandId: CommandId.make("stop-all"),
      threadId,
    });
    assert.deepEqual(yield* watchesOf(threadId), []);
    const again = yield* orchestrator.dispatch({
      type: "thread.command-watch.stop",
      commandId: CommandId.make("stop-all-again"),
      threadId,
    });
    assert.lengthOf(again.storedEvents, 0);

    // A watch keeps a thread that is otherwise done waiting rather than ready.
    yield* startWatch(threadId, runId, "command-watch:g", "echo g");
    yield* finishRuns(threadId);
    const shell = yield* orchestrator.getThreadShell(threadId);
    assert.deepEqual(
      shell?.pendingBackgroundTasks?.map((task) => task.taskId),
      ["command-watch:g"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a watch outside Full access, from plan mode, or from a run that ended", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;

    const supervised = ThreadId.make("thread:command-watch-supervised");
    yield* createThread(supervised, { runtimeMode: "approval-required" });
    const supervisedRun = yield* startRun(supervised, "work");
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(startWatch(supervised, supervisedRun, "command-watch:a", "x")),
      ),
    );

    const planning = ThreadId.make("thread:command-watch-plan");
    yield* createThread(planning, { interactionMode: "plan" });
    const planningRun = yield* startRun(planning, "work");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(startWatch(planning, planningRun, "command-watch:a", "x"))),
    );

    // Run A asked, then Stop reached A and the user started run B: A's slow call is refused.
    const threadId = ThreadId.make("thread:command-watch-stale");
    yield* createThread(threadId);
    const runA = yield* startRun(threadId, "first");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:command-watch-stale:interrupt"),
      type: "turn-item.updated",
      threadId,
      runId: runA,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:command-watch-stale:interrupt"),
        threadId,
        runId: runA,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId!,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop",
      },
    });
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(startWatch(threadId, runA, "command-watch:a", "x"))),
    );
    yield* finishRuns(threadId);
    const runB = yield* startRun(threadId, "second");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(startWatch(threadId, runA, "command-watch:a", "x"))),
    );
    yield* startWatch(threadId, runB, "command-watch:b", "x");
    assert.deepEqual(yield* watchesOf(threadId), ["command-watch:b"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "settle", end: (threadId: ThreadId) => ({ type: "thread.settle" as const, threadId }) },
  { name: "archive", end: (threadId: ThreadId) => ({ type: "thread.archive" as const, threadId }) },
  { name: "stop", end: (threadId: ThreadId) => ({ type: "thread.stop" as const, threadId }) },
  {
    name: "leaving Full access",
    end: (threadId: ThreadId) => ({
      type: "thread.runtime-mode.set" as const,
      threadId,
      runtimeMode: "approval-required" as const,
    }),
  },
  {
    name: "plan mode",
    end: (threadId: ThreadId) => ({
      type: "thread.interaction-mode.set" as const,
      threadId,
      interactionMode: "plan" as const,
    }),
  },
])("$name ends command watches", ({ name, end }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:command-watch-end-${name}`);
    yield* createThread(threadId);
    const runId = yield* startRun(threadId, "work");
    yield* startWatch(threadId, runId, "command-watch:a", "echo a");
    yield* finishRuns(threadId);
    yield* orchestrator.dispatch({ ...end(threadId), commandId: CommandId.make(`end:${name}`) });
    assert.deepEqual(yield* watchesOf(threadId), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes on new output, waits out a busy thread, and ends after repeated failures", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:command-watch-reactor");
    yield* createThread(threadId);
    const runId = yield* startRun(threadId, "work");
    yield* startWatch(threadId, runId, "command-watch:a", "gh api discussion");
    yield* finishRuns(threadId);

    let next = output({ code: 1 as ProcessRunner.ProcessRunOutput["code"] });
    const runner = fakeRunner(() => next);
    yield* Effect.gen(function* () {
      const reactor = yield* CommandWatchReactor.make;
      const look = reactor.sweep.pipe(Effect.andThen(reactor.awaitRuns));

      // The first run only sets the baseline, which is not thread activity.
      const before = (yield* orchestrator.getThreadProjection(threadId)).thread.updatedAt;
      yield* look;
      assert.lengthOf(runner.calls, 1);
      assert.strictEqual(runner.calls[0]?.cwd, process.cwd());
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.updatedAt,
        before,
      );

      // Not due again until its interval passes.
      yield* look;
      assert.lengthOf(runner.calls, 1);

      next = output({ stdout: "maintainer: approved\n" });
      yield* TestClock.adjust("10 minutes");
      yield* look;
      const woken = yield* orchestrator.getThreadProjection(threadId);
      assert.strictEqual(woken.thread.commandWatches?.[0]?.wakes, 1);
      const wake = woken.messages.at(-1);
      assert.include(wake?.text ?? "", "maintainer: approved");
      assert.strictEqual(wake?.notification?.source.kind, "monitor");

      // The wake started a turn, so the watch waits for it.
      yield* TestClock.adjust("10 minutes");
      yield* look;
      assert.lengthOf(runner.calls, 2);

      yield* finishRuns(threadId);
      next = output({ code: 2 as ProcessRunner.ProcessRunOutput["code"], stderr: "boom" });
      for (let attempt = 0; attempt < 8; attempt++) {
        yield* TestClock.adjust("10 minutes");
        yield* look;
      }
      assert.lengthOf(runner.calls, 10);
      assert.deepEqual(yield* watchesOf(threadId), []);
      const ended = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1);
      assert.include(ended?.text ?? "", "after 8 failed runs in a row");
    }).pipe(Effect.provide(runner.layer), Effect.scoped);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("takes the baseline during the turn that starts the watch, without waking it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:command-watch-baseline");
    yield* createThread(threadId);
    const runId = yield* startRun(threadId, "work");
    yield* startWatch(threadId, runId, "command-watch:a", "gh api discussion");

    let next = output({ stdout: "closed\n" });
    const runner = fakeRunner(() => next);
    yield* Effect.gen(function* () {
      const reactor = yield* CommandWatchReactor.make;
      const look = reactor.sweep.pipe(Effect.andThen(reactor.awaitRuns));
      const messagesBefore = (yield* orchestrator.getThreadProjection(threadId)).messages.length;

      // The turn is still running: only the baseline may run, and it wakes nobody.
      yield* look;
      assert.lengthOf(runner.calls, 1);
      const [baselined] = (yield* orchestrator.getThreadProjection(threadId)).thread
        .commandWatches!;
      assert.isNotNull(baselined?.lastOutputHash);
      assert.strictEqual(baselined?.wakes, 0);
      yield* TestClock.adjust("10 minutes");
      yield* look;
      assert.lengthOf(runner.calls, 1);

      // The state that held at the start is not news once the turn ends.
      yield* finishRuns(threadId);
      yield* TestClock.adjust("10 minutes");
      yield* look;
      assert.lengthOf(runner.calls, 2);
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).messages, messagesBefore);

      next = output({ stdout: "reopened\n" });
      yield* TestClock.adjust("10 minutes");
      yield* look;
      const woken = yield* orchestrator.getThreadProjection(threadId);
      assert.strictEqual(woken.thread.commandWatches?.[0]?.wakes, 1);
      assert.include(woken.messages.at(-1)?.text ?? "", "reopened");
    }).pipe(Effect.provide(runner.layer), Effect.scoped);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a watch whose final wake failed to write on an active thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:command-watch-end-retry");
    yield* createThread(threadId);
    const runId = yield* startRun(threadId, "work");
    yield* startWatch(threadId, runId, "command-watch:a", "gh api discussion");
    yield* finishRuns(threadId);

    const runner = fakeRunner(() =>
      output({ code: 2 as ProcessRunner.ProcessRunOutput["code"], stderr: "boom" }),
    );
    let failNextWake = true;
    const layerFlakyWrite = Layer.effect(
      Orchestrator.OrchestratorV2,
      Effect.gen(function* () {
        const real = yield* Orchestrator.OrchestratorV2;
        return {
          ...real,
          dispatch: (command) => {
            if (failNextWake && command.type === "thread.command-watch.sync" && command.wake) {
              failNextWake = false;
              return Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
              );
            }
            return real.dispatch(command);
          },
        } satisfies Orchestrator.OrchestratorV2["Service"];
      }),
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* CommandWatchReactor.make;
      const look = reactor.sweep.pipe(Effect.andThen(reactor.awaitRuns));
      for (let attempt = 0; attempt < 8; attempt++) {
        yield* look;
        yield* TestClock.adjust("10 minutes");
      }
      assert.deepEqual(yield* watchesOf(threadId), ["command-watch:a"]);
      yield* look;
      assert.deepEqual(yield* watchesOf(threadId), []);
      const ended = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1);
      assert.include(ended?.text ?? "", "after 8 failed runs in a row");
    }).pipe(Effect.provide(Layer.merge(runner.layer, layerFlakyWrite)), Effect.scoped);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stopping a watch interrupts its run without waiting for the next look", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const layerRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* CommandWatchReactor.make;
      // Listening starts before the thread exists, so the stop below is an event it sees.
      yield* reactor.start();
      const threadId = ThreadId.make("thread:command-watch-cancel");
      yield* createThread(threadId);
      const runId = yield* startRun(threadId, "work");
      yield* startWatch(threadId, runId, "command-watch:a", "sleep 600");
      yield* finishRuns(threadId);

      yield* reactor.sweep;
      yield* Deferred.await(started);
      yield* orchestrator.dispatch({
        type: "thread.command-watch.stop",
        commandId: CommandId.make("stop-running"),
        threadId,
      });
      yield* Deferred.await(interrupted);
      yield* reactor.awaitRuns;
    }).pipe(Effect.provide(layerRunner), Effect.scoped);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("runs the most overdue watch first, so a slow one cannot starve the others", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:command-watch-fair");
    yield* createThread(threadId);
    const runId = yield* startRun(threadId, "work");
    yield* startWatch(threadId, runId, "command-watch:a", "first");
    yield* startWatch(threadId, runId, "command-watch:b", "second");
    yield* finishRuns(threadId);

    const runner = fakeRunner(() => output({ code: 1 as ProcessRunner.ProcessRunOutput["code"] }));
    yield* Effect.gen(function* () {
      const reactor = yield* CommandWatchReactor.make;
      const look = reactor.sweep.pipe(Effect.andThen(reactor.awaitRuns));
      yield* look;
      // Watch a ran first and is due again by the time watch b, never run, gets its turn.
      yield* TestClock.adjust("11 minutes");
      yield* look;
      yield* TestClock.adjust("11 minutes");
      yield* look;
      assert.deepEqual(
        runner.calls.map((call) => call.args.at(-1)),
        ["first", "second", "first"],
      );
    }).pipe(Effect.provide(runner.layer), Effect.scoped);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends a watch after its lifetime and tells the agent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:command-watch-expiry");
    yield* createThread(threadId);
    const runId = yield* startRun(threadId, "work");
    yield* startWatch(threadId, runId, "command-watch:a", "never prints");
    yield* finishRuns(threadId);

    const runner = fakeRunner(() => output({}));
    yield* Effect.gen(function* () {
      const reactor = yield* CommandWatchReactor.make;
      yield* reactor.sweep.pipe(Effect.andThen(reactor.awaitRuns));
      assert.deepEqual(yield* watchesOf(threadId), ["command-watch:a"]);
      yield* TestClock.adjust("7 days");
      yield* reactor.sweep.pipe(Effect.andThen(reactor.awaitRuns));
      assert.deepEqual(yield* watchesOf(threadId), []);
      const ended = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1);
      assert.include(ended?.text ?? "", "after 7 days");
    }).pipe(Effect.provide(runner.layer), Effect.scoped);
  }).pipe(Effect.provide(layerTest)),
);

import { assert, it } from "@effect/vitest";
import {
  GracefulShutdownId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as GracefulShutdown from "./GracefulShutdown.ts";
import * as GracefulShutdownGate from "./GracefulShutdownGate.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const makeGracefulHarness = Effect.fn("test.make_graceful_shutdown_harness")(function* (input: {
  readonly shells: Ref.Ref<ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly resumeCalls?: Ref.Ref<number>;
  readonly runsByThread?: ReadonlyMap<ThreadId, ReadonlyArray<Partial<OrchestrationV2Run>>>;
  readonly promptSaveWork?: boolean;
}) {
  const resumeCalls = input.resumeCalls ?? (yield* Ref.make(0));
  const dispatches = yield* Ref.make<ReadonlyArray<string>>([]);
  const gateLayer = GracefulShutdownGate.layer;
  const threadsLayer = Layer.succeed(ThreadManagementService.ThreadManagementService, {
    getShellSnapshot: () =>
      Ref.get(input.shells).pipe(Effect.map((threads) => ({ threads, sequence: 0 }))),
    listProjectThreads: () => Effect.succeed([]),
    getThreadRecords: (threadId: ThreadId) =>
      Effect.succeed({
        runs: input.runsByThread?.get(threadId) ?? [],
        providerSessions: [{ id: "session-a", providerInstanceId: "provider-a", status: "ready" }],
        providerThreads: [],
      }),
    dispatch: (command: { readonly type: string; readonly threadId: ThreadId }) =>
      Ref.update(dispatches, (existing) => [
        ...existing,
        `${command.type}:${command.threadId}`,
      ]).pipe(Effect.as({ sequence: 0, storedEvents: [], replayed: false })),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
  const orchestratorLayer = Layer.succeed(Orchestrator.OrchestratorV2, {
    resumeQueuedRuns: Ref.update(resumeCalls, (count) => count + 1).pipe(Effect.as(1)),
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const settingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
    getSettings: Effect.succeed({
      promptSaveWorkOnGracefulShutdown: input.promptSaveWork ?? false,
    }),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);

  return {
    dispatches,
    resumeCalls,
    layer: Layer.mergeAll(
      GracefulShutdown.layer.pipe(
        Layer.provide(Layer.mergeAll(gateLayer, threadsLayer, orchestratorLayer, settingsLayer)),
      ),
      gateLayer,
    ),
  };
});

it.effect("complete clears the drain and resumes queued runs without queue.resume", () =>
  Effect.gen(function* () {
    const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]);
    const harness = yield* makeGracefulHarness({ shells });

    yield* Effect.gen(function* () {
      const gate = yield* GracefulShutdownGate.GracefulShutdownGate;
      const graceful = yield* GracefulShutdown.GracefulShutdown;
      const providerA = ProviderInstanceId.make("provider-a");
      yield* gate.setState({
        phase: "quiesced",
        shutdownId: GracefulShutdownId.make("shutdown-a"),
        scope: { type: "provider", providerInstanceId: providerA },
        reason: "test",
        startedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "2026-01-01T00:02:00.000Z",
        saveWorkPrompted: false,
        saveWorkMessageIds: new Set(),
        saveWorkThreadIds: new Set([ThreadId.make("thread-b")]),
      });

      yield* graceful.complete(GracefulShutdownId.make("shutdown-a"));

      assert.isFalse(GracefulShutdownGate.isDrainActive(yield* gate.getState));
      assert.strictEqual(yield* Ref.get(harness.resumeCalls), 1);
      assert.deepStrictEqual(yield* Ref.get(harness.dispatches), []);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("beginAndAwait fails when complete clears the drain before it finishes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-drain");
    const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([
      {
        id: threadId,
        archivedAt: null,
        deletedAt: null,
        providerInstanceId: ProviderInstanceId.make("provider-a"),
        activeRunId: RunId.make("run-active"),
        activityRunStatus: "running",
      } as OrchestrationV2ThreadShell,
    ]);
    const harness = yield* makeGracefulHarness({ shells });

    yield* Effect.gen(function* () {
      const gate = yield* GracefulShutdownGate.GracefulShutdownGate;
      const graceful = yield* GracefulShutdown.GracefulShutdown;

      const drain = yield* Effect.forkChild(
        graceful.beginAndAwait({
          scope: { type: "environment" },
          promptSaveWork: false,
          timeoutMs: 5_000,
        }),
        { startImmediately: true },
      );

      // tryBegin runs before the first waitQuiesced sleep.
      assert.isTrue(GracefulShutdownGate.isDrainActive(yield* gate.getState));

      yield* graceful.complete();
      assert.isFalse(GracefulShutdownGate.isDrainActive(yield* gate.getState));

      yield* Ref.set(shells, [
        {
          id: threadId,
          archivedAt: null,
          deletedAt: null,
          providerInstanceId: ProviderInstanceId.make("provider-a"),
          activeRunId: null,
          activityRunStatus: null,
        } as OrchestrationV2ThreadShell,
      ]);
      yield* TestClock.adjust("250 millis");

      const error = yield* Fiber.join(drain).pipe(Effect.flip);
      assert.strictEqual(error.reason, "That graceful shutdown is no longer active.");
      assert.isFalse(GracefulShutdownGate.isDrainActive(yield* gate.getState));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("save-work prompts reach only threads with an active run", () =>
  Effect.gen(function* () {
    const busy = ThreadId.make("thread-busy");
    const idle = ThreadId.make("thread-idle");
    const shell = (id: ThreadId) =>
      ({
        id,
        archivedAt: null,
        deletedAt: null,
        providerInstanceId: ProviderInstanceId.make("provider-a"),
        activeRunId: null,
        activityRunStatus: null,
      }) as OrchestrationV2ThreadShell;
    const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([
      shell(busy),
      shell(idle),
    ]);
    const harness = yield* makeGracefulHarness({
      shells,
      promptSaveWork: true,
      runsByThread: new Map([
        [busy, [{ status: "running", providerInstanceId: ProviderInstanceId.make("provider-a") }]],
      ]),
    });

    yield* Effect.gen(function* () {
      const graceful = yield* GracefulShutdown.GracefulShutdown;
      yield* graceful.beginAndAwait({ scope: { type: "environment" } });
      assert.deepStrictEqual(yield* Ref.get(harness.dispatches), [`message.dispatch:${busy}`]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

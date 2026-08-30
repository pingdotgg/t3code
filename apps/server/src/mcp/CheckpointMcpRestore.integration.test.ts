// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import * as McpSessionRegistryTestkit from "./McpSessionRegistry.testkit.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "../orchestration-v2/EffectWorker.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import {
  ThreadDispatchLockV2,
  threadDispatchLockLayer,
} from "../orchestration-v2/KeyedSerialExecutor.ts";
import {
  OrchestratorCheckpointRollbackTargetUnsupportedError,
  OrchestratorV2,
} from "../orchestration-v2/Orchestrator.ts";
import {
  ProviderAdapterRollbackThreadError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import * as CheckpointMcp from "./CheckpointMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-checkpoint-restore-test");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-test" };
const isRollbackTargetUnsupported = Schema.is(OrchestratorCheckpointRollbackTargetUnsupportedError);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-mcp-restore-",
});

function makeAdapter(input: {
  readonly rollbackCount: Ref.Ref<number>;
  readonly failProviderRollback: boolean;
}): ProviderAdapterV2Shape {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (openInput) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: openInput.providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: openInput.runtimePolicy.cwd ?? "/repo",
          model: openInput.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: openInput.providerSessionId,
          providerSession,
          events: Stream.empty,
          ensureThread: () => Effect.die("ensureThread is unused in checkpoint restore"),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: () => Effect.die("startTurn is unused in checkpoint restore"),
          steerTurn: () => Effect.die("steerTurn is unused in checkpoint restore"),
          interruptTurn: () => Effect.die("interruptTurn is unused in checkpoint restore"),
          respondToRuntimeRequest: () =>
            Effect.die("respondToRuntimeRequest is unused in checkpoint restore"),
          readThreadSnapshot: () =>
            Effect.die("readThreadSnapshot is unused in checkpoint restore"),
          rollbackThread: ({ providerThread, target }) =>
            Ref.update(input.rollbackCount, (count) => count + 1).pipe(
              Effect.andThen(
                input.failProviderRollback
                  ? Effect.fail(
                      new ProviderAdapterRollbackThreadError({
                        driver,
                        providerThreadId: providerThread.id,
                        checkpointId: target.checkpointId,
                        cause: "simulated provider rollback failure",
                      }),
                    )
                  : Effect.succeed({
                      providerThread,
                      providerTurns: [],
                      messages: [],
                      runtimeRequests: [],
                    }),
              ),
            ),
          forkThread: () => Effect.die("forkThread is unused in checkpoint restore"),
        } satisfies ProviderAdapterV2SessionRuntime;
      }),
  };
}

function makeIntegrationLayer(input: {
  readonly rollbackCount: Ref.Ref<number>;
  readonly failProviderRollback: boolean;
  readonly fingerprintGate?: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}) {
  const adapter = makeAdapter(input);
  const providerInstance = {
    instanceId: providerInstanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "codex:checkpoint-restore" },
    displayName: "Checkpoint restore provider",
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: adapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
  const providerRegistry = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const vcsRegistry = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(ServerConfigLayer),
    Layer.provide(NodeServices.layer),
  );
  const checkpointStoreLive = CheckpointStore.layer.pipe(Layer.provide(vcsRegistry));
  const fingerprintGate = input.fingerprintGate;
  const checkpointStore =
    fingerprintGate === undefined
      ? checkpointStoreLive
      : Layer.effect(
          CheckpointStore.CheckpointStore,
          Effect.gen(function* () {
            const store = yield* CheckpointStore.CheckpointStore;
            let fingerprintReads = 0;
            return CheckpointStore.CheckpointStore.of({
              ...store,
              readWorkspaceFingerprint: (cwd) =>
                store.readWorkspaceFingerprint(cwd).pipe(
                  Effect.tap(() => {
                    fingerprintReads += 1;
                    return fingerprintReads === 2
                      ? Deferred.succeed(fingerprintGate.entered, undefined).pipe(
                          Effect.andThen(Deferred.await(fingerprintGate.release)),
                        )
                      : Effect.void;
                  }),
                ),
            });
          }),
        ).pipe(Layer.provide(checkpointStoreLive));
  const runtime = Layer.merge(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(checkpointStore),
    Layer.provide(ServerConfigLayer),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(providerRegistry),
    Layer.provide(NodeServices.layer),
  );
  const runtimeWithDispatchLock = Layer.merge(runtime, threadDispatchLockLayer);
  return CheckpointMcp.layer.pipe(
    Layer.provideMerge(runtimeWithDispatchLock),
    Layer.provideMerge(NodeServices.layer),
  );
}

function seedRollbackProjection(input: {
  readonly eventSink: EventSinkV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
  readonly runId: RunId;
  readonly scopeId: CheckpointScopeId;
  readonly checkpointId: CheckpointId;
  readonly checkpointRef: CheckpointRef;
  readonly cwd: string;
  readonly checkpointOrdinal?: number;
}) {
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    const providerSession: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver,
      providerInstanceId,
      status: "ready",
      cwd: input.cwd,
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: input.providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: input.providerSessionId,
      appThreadId: input.threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "native-checkpoint-thread", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    };
    const completedRun: OrchestrationV2Run = {
      id: input.runId,
      threadId: input.threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: input.providerThreadId,
      userMessageId: MessageId.make("message:checkpoint-restore:completed"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      queuePosition: null,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    const scopeNodeId = NodeId.make("node:checkpoint-restore:scope");
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make("event:checkpoint-restore:provider-session"),
        type: "provider-session.attached",
        threadId: input.threadId,
        providerInstanceId,
        occurredAt: now,
        payload: providerSession,
      },
      {
        id: EventId.make("event:checkpoint-restore:provider-thread"),
        type: "provider-thread.updated",
        threadId: input.threadId,
        providerInstanceId,
        occurredAt: now,
        payload: providerThread,
      },
      {
        id: EventId.make("event:checkpoint-restore:completed-run"),
        type: "run.created",
        threadId: input.threadId,
        runId: input.runId,
        providerInstanceId,
        occurredAt: now,
        payload: completedRun,
      },
      {
        id: EventId.make("event:checkpoint-restore:scope"),
        type: "checkpoint-scope.created",
        threadId: input.threadId,
        nodeId: scopeNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: input.scopeId,
          threadId: input.threadId,
          runId: null,
          nodeId: scopeNodeId,
          parentScopeId: null,
          providerThreadId: input.providerThreadId,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: input.cwd,
          createdAt: now,
        },
      },
      {
        id: EventId.make("event:checkpoint-restore:checkpoint"),
        type: "checkpoint.captured",
        threadId: input.threadId,
        nodeId: scopeNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: input.checkpointId,
          threadId: input.threadId,
          scopeId: input.scopeId,
          runId: null,
          nodeId: scopeNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: input.checkpointOrdinal ?? 0,
          appRunOrdinal: null,
          ref: input.checkpointRef,
          status: "ready",
          files: [],
          capturedAt: now,
        },
      },
    ];
    yield* input.eventSink.write({ events });
  });
}

function restoreScenario(
  input: {
    readonly failProviderRollback: boolean;
    readonly admitRunBeforeWorker?: boolean;
    readonly raceMessageDuringRestore?: boolean;
    readonly fingerprintGate?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  },
  rollbackCount: Ref.Ref<number>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(
        input.admitRunBeforeWorker
          ? "mcp-restore-concurrent-run"
          : input.failProviderRollback
            ? "mcp-restore-partial"
            : "mcp-restore-applied",
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const threadDispatch = yield* ThreadDispatchLockV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const service = yield* CheckpointMcp.CheckpointMcpService;
      const threadId = ThreadId.make(
        input.admitRunBeforeWorker
          ? "thread:checkpoint-restore:concurrent-run"
          : input.failProviderRollback
            ? "thread:checkpoint-restore:partial"
            : "thread:checkpoint-restore:applied",
      );
      const providerSessionId = ProviderSessionId.make(`provider-session:${threadId}`);
      const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
      const runId = RunId.make(`run:${threadId}:completed`);
      const scopeId = CheckpointScopeId.make(`scope:${threadId}`);
      const checkpointId = CheckpointId.make(`checkpoint:${threadId}`);
      const checkpointRef = CheckpointRef.make(
        input.admitRunBeforeWorker
          ? "refs/t3/test/checkpoint-restore-concurrent-run"
          : input.failProviderRollback
            ? "refs/t3/test/checkpoint-restore-partial"
            : "refs/t3/test/checkpoint-restore-applied",
      );
      const readmePath = NodePath.join(cwd, "README.md");

      yield* fileSystem.writeFileString(readmePath, "checkpoint contents\n");
      yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef });
      yield* fileSystem.writeFileString(readmePath, "current unsaved contents\n");
      yield* fileSystem.writeFileString(NodePath.join(cwd, "untracked.txt"), "remove me\n");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:checkpoint-restore"),
        title: "Checkpoint restore integration",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/checkpoint-restore",
        worktreePath: cwd,
      });
      yield* seedRollbackProjection({
        eventSink,
        threadId,
        providerSessionId,
        providerThreadId,
        runId,
        scopeId,
        checkpointId,
        checkpointRef,
        cwd,
      });

      const invocation: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:checkpoint-restore"),
        threadId,
        providerSessionId: `mcp-session:${threadId}`,
        providerInstanceId,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const restoreInput = {
        scopeId,
        checkpointId,
        discardChanges: true as const,
        clientRequestId: "restore-integration-key",
      };
      const requested = yield* service.restore(invocation, restoreInput);
      const acceptedRetry = yield* service.restore(invocation, restoreInput);
      assert.equal(requested.status, "REQUESTED");
      assert.equal(acceptedRetry.commandId, requested.commandId);
      assert.lengthOf(yield* orchestrator.listCommandEffects(requested.commandId), 1);

      if (input.admitRunBeforeWorker === true) {
        const now = yield* DateTime.now;
        const queuedRunId = RunId.make(`run:concurrent:${threadId}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`event:concurrent-run:${threadId}`),
              type: "run.created",
              threadId,
              runId: queuedRunId,
              providerInstanceId,
              occurredAt: now,
              payload: {
                id: queuedRunId,
                threadId,
                ordinal: 2,
                providerInstanceId,
                modelSelection,
                providerThreadId,
                userMessageId: MessageId.make(`message:concurrent-run:${threadId}`),
                rootNodeId: null,
                activeAttemptId: null,
                status: "queued",
                queuePosition: 1,
                requestedAt: now,
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
      }

      if (input.raceMessageDuringRestore === true) {
        if (input.fingerprintGate === undefined) {
          return yield* Effect.die("fingerprint gate is required for the admission race");
        }
        const completionOrder = yield* Ref.make<ReadonlyArray<"restore" | "message">>([]);
        const workerFiber = yield* worker.runOnce.pipe(
          Effect.tap(() => Ref.update(completionOrder, (order) => [...order, "restore" as const])),
          Effect.forkChild,
        );
        yield* Deferred.await(input.fingerprintGate.entered);
        const lockProbe = yield* threadDispatch
          .withLock(threadId, Effect.void)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.isTrue(
          lockProbe.pollUnsafe() === undefined,
          "the guarded restore worker must hold the shared thread admission lock",
        );
        const dispatchEntered = yield* Deferred.make<void>();
        const messageFiber = yield* Deferred.succeed(dispatchEntered, undefined).pipe(
          Effect.andThen(
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "mcp",
              commandId: CommandId.make(`command:message-during-restore:${threadId}`),
              threadId,
              messageId: MessageId.make(`message:during-restore:${threadId}`),
              text: "Run after checkpoint restoration.",
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            }),
          ),
          Effect.tap(() => Ref.update(completionOrder, (order) => [...order, "message" as const])),
          Effect.forkChild,
        );
        yield* Deferred.await(dispatchEntered);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(input.fingerprintGate.release, undefined);
        assert.isTrue(yield* Fiber.join(workerFiber));
        yield* Fiber.join(lockProbe);
        yield* Fiber.join(messageFiber);
        assert.deepEqual(yield* Ref.get(completionOrder), ["restore", "message"]);
      } else {
        assert.isTrue(yield* worker.runOnce);
      }
      const settled = yield* service.restore(invocation, restoreInput);
      assert.equal(
        settled.status,
        input.admitRunBeforeWorker ? "FAILED" : input.failProviderRollback ? "PARTIAL" : "APPLIED",
      );
      assert.equal(yield* Ref.get(rollbackCount), input.admitRunBeforeWorker ? 0 : 1);
      assert.equal(
        yield* fileSystem.readFileString(readmePath),
        input.admitRunBeforeWorker ? "current unsaved contents\n" : "checkpoint contents\n",
      );
      assert.equal(
        yield* fileSystem.exists(NodePath.join(cwd, "untracked.txt")),
        input.admitRunBeforeWorker === true,
      );
      assert.lengthOf(yield* orchestrator.listCommandEffects(requested.commandId), 1);
      if (input.admitRunBeforeWorker !== true && input.raceMessageDuringRestore !== true) {
        assert.isFalse(yield* worker.runOnce);
      }
    }),
  );
}

it.effect("restores temporary Git state once through real V2 and reports applied", () =>
  Effect.gen(function* () {
    const rollbackCount = yield* Ref.make(0);
    return yield* restoreScenario({ failProviderRollback: false }, rollbackCount).pipe(
      Effect.provide(makeIntegrationLayer({ rollbackCount, failProviderRollback: false })),
    );
  }),
);

it.effect("reports provider failure after real filesystem restore as partial without retry", () =>
  Effect.gen(function* () {
    const rollbackCount = yield* Ref.make(0);
    return yield* restoreScenario({ failProviderRollback: true }, rollbackCount).pipe(
      Effect.provide(makeIntegrationLayer({ rollbackCount, failProviderRollback: true })),
    );
  }),
);

it.effect("rejects work admitted after acceptance at the worker workspace boundary", () =>
  Effect.gen(function* () {
    const rollbackCount = yield* Ref.make(0);
    return yield* restoreScenario(
      { failProviderRollback: false, admitRunBeforeWorker: true },
      rollbackCount,
    ).pipe(Effect.provide(makeIntegrationLayer({ rollbackCount, failProviderRollback: false })));
  }),
);

it.effect("serializes message admission across the guarded restore critical section", () =>
  Effect.gen(function* () {
    const rollbackCount = yield* Ref.make(0);
    const fingerprintGate = {
      entered: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    return yield* restoreScenario(
      {
        failProviderRollback: false,
        raceMessageDuringRestore: true,
        fingerprintGate,
      },
      rollbackCount,
    ).pipe(
      Effect.provide(
        makeIntegrationLayer({
          rollbackCount,
          failProviderRollback: false,
          fingerprintGate,
        }),
      ),
    );
  }),
);

it.effect("rejects a nonzero materialized baseline in the serialized command decision", () =>
  Effect.gen(function* () {
    const rollbackCount = yield* Ref.make(0);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("mcp-restore-ambiguous-baseline");
        const orchestrator = yield* OrchestratorV2;
        const eventSink = yield* EventSinkV2;
        const threadId = ThreadId.make("thread:checkpoint-restore:ambiguous-baseline");
        const providerSessionId = ProviderSessionId.make(`provider-session:${threadId}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
        const scopeId = CheckpointScopeId.make(`scope:${threadId}`);
        const checkpointId = CheckpointId.make(`checkpoint:${threadId}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:create:${threadId}`),
          threadId,
          projectId: ProjectId.make("project:checkpoint-restore"),
          title: "Ambiguous checkpoint baseline",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* seedRollbackProjection({
          eventSink,
          threadId,
          providerSessionId,
          providerThreadId,
          runId: RunId.make(`run:${threadId}:completed`),
          scopeId,
          checkpointId,
          checkpointRef: CheckpointRef.make("refs/t3/test/ambiguous-baseline"),
          cwd,
          checkpointOrdinal: 2,
        });

        const error = yield* orchestrator
          .dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make(`command:rollback:${threadId}`),
            threadId,
            scopeId,
            checkpointId,
            expectedIdle: true,
            expectedWorkspaceFingerprint: "workspace-before",
          })
          .pipe(Effect.flip);
        assert.isTrue(isRollbackTargetUnsupported(error));
      }),
    ).pipe(Effect.provide(makeIntegrationLayer({ rollbackCount, failProviderRollback: false })));
  }),
);

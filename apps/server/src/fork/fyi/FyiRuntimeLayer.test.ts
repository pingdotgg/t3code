import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstallationGate from "../../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "../../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as FyiDelivery from "./FyiDelivery.ts";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fork-fyi-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by lifecycle tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedNone,
    }),
  ),
  Layer.provide(layerPlatformTest),
);

it.effect("a turn in a non-Git workspace carries a waiting FYI, and its rewind returns it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-non-git-fyi-" });
    const threadId = ThreadId.make("runtime-non-git-fyi");
    const rollbackThread = vi.fn(
      ({ providerThread }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
        Effect.succeed({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver,
              nativeId: "rewound-native-thread",
              strength: "strong" as const,
            },
          },
        }),
    );
    const prompts: Array<string> = [];
    const sessionSpy = vi.spyOn(sessions, "open").mockImplementation((input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          driver,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: ({
            existingProviderThread,
          }: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) =>
            Effect.succeed(existingProviderThread),
          startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            Effect.sync(() => {
              prompts.push(turn.message.text);
            }),
          rollbackThread,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("non-git-fyi-create"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("non-git-fyi-project"),
      title: "Non-Git FYI",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
    });

    const completeMessage = (name: string, startsProviderTurn = false) =>
      Effect.gen(function* () {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(name),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make(name),
          text: name,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        if (startsProviderTurn) yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const run = projection.runs.find((candidate) => candidate.userMessageId === name)!;
        const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === run.providerThreadId,
        )!;
        const now = yield* DateTime.now;
        const commandId = CommandId.make(`${name}-complete`);
        // The provider completion is the fixture boundary; capture and rollback use real effects.
        yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "provider completion supplied by fixture",
        });
        yield* eventSink.writeWithEffects({
          commandId,
          events: [
            {
              id: EventId.make(`${name}-run`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "waiting", startedAt: now },
            },
            {
              id: EventId.make(`${name}-node`),
              type: "node.updated",
              threadId,
              runId: run.id,
              nodeId: node.id,
              occurredAt: now,
              payload: { ...node, status: "completed", completedAt: now },
            },
            {
              id: EventId.make(`${name}-turn`),
              type: "provider-turn.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: ProviderTurnId.make(`${name}-turn`),
                providerThreadId: providerThread.id,
                nodeId: node.id,
                runAttemptId: run.activeAttemptId,
                nativeTurnRef: null,
                ordinal: run.ordinal,
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
          ],
          effects: [
            {
              id: `${name}-capture`,
              commandId,
              threadId,
              request: {
                type: "checkpoint.capture",
                runId: run.id,
                scopeId: node.checkpointScopeId!,
              },
            },
          ],
        });
        yield* worker.drain();
        const captured = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          captured.runs.find((candidate) => candidate.id === run.id)?.status,
          "completed",
        );
        return { run };
      });

    yield* completeMessage("non-git-fyi-first");
    const fyiMessageId = MessageId.make("non-git-fyi");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("non-git-fyi"),
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: ThreadId.make("non-git-chief"),
      threadId,
      messageId: fyiMessageId,
      text: "main moved",
      attachments: [],
      dispatchMode: { type: "fyi" },
    });
    const fyiRunId = orchestrator
      .getThreadProjection(threadId)
      .pipe(
        Effect.map(
          (projection) =>
            projection.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === fyiMessageId,
            )?.runId,
        ),
      );
    const second = yield* completeMessage("non-git-fyi-second", true);
    assert.lengthOf(prompts, 1);
    assert.include(prompts[0], "main moved", "the turn's prompt carries the FYI");
    assert.equal(yield* fyiRunId, second.run.id);

    const baseline = (yield* orchestrator.getThreadProjection(threadId)).checkpoints.find(
      (checkpoint) => checkpoint.ordinalWithinScope === 0,
    )!;
    const rewindCommandId = CommandId.make("non-git-fyi-rewind");
    yield* orchestrator.dispatch({
      type: "checkpoint.rollback",
      commandId: rewindCommandId,
      threadId,
      checkpointId: baseline.id,
      scopeId: baseline.scopeId,
      restoreFiles: false,
    });
    yield* worker.drain();
    assert.deepEqual(
      (yield* outbox.listByCommandId(rewindCommandId)).map((effect) => effect.status),
      ["succeeded"],
    );
    assert.isNull(yield* fyiRunId, "a rollback returns the FYI its run carried");
  }).pipe(Effect.provide(Layer.merge(Layer.fresh(layerTest), NodeServices.layer))),
);

/** The runtime beside the adapters' own infrastructure, built as one graph as the server builds them. */
const layerAdapterInfrastructureTest = Layer.mergeAll(
  layerTest,
  ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provide(Layer.merge(PortScanner.layerTest, SqlitePersistence.layerMemory)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerServerConfig),
    Layer.provide(McpProviderSessions.layer),
    Layer.provide(ProviderInstallationGate.layer),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

it.layer(layerAdapterInfrastructureTest)("FYI delivery in the adapters", (it) => {
  it.effect("an FYI an adapter binds reaches the orchestrator's event stream", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const fyi = yield* FyiDelivery.FyiDelivery;
      const threadId = ThreadId.make("runtime-fyi-adapter-bind");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-fyi-adapter-bind-create"),
        threadId,
        projectId: ProjectId.make("runtime-fyi-adapter-bind-project"),
        title: "FYI bind",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/t3-runtime-fyi-adapter-bind",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("runtime-fyi-adapter-bind-note"),
        threadId,
        messageId: MessageId.make("runtime-fyi-adapter-bind-note"),
        text: "main moved",
        attachments: [],
        dispatchMode: { type: "fyi" },
      });
      const runId = RunId.make("runtime-fyi-adapter-bind-run");
      const published = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.runId === runId,
        ),
        Stream.take(1),
        Stream.runDrain,
        // The stream starts at the latest event, so it must subscribe before the bind commits.
        Effect.forkScoped({ startImmediately: true }),
      );
      const text = yield* fyi.forToolBatch({
        threadId,
        carrier: {
          runId,
          nodeId: NodeId.make("runtime-fyi-adapter-bind-node"),
          providerThreadId: ProviderThreadId.make("runtime-fyi-adapter-bind-provider-thread"),
        },
        stop: () => false,
      });
      assert.include(text, "main moved");
      yield* Fiber.join(published);
    }),
  );
});

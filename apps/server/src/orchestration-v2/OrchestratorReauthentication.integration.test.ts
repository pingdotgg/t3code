import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderFailureClass,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  ProviderEventIngestorV2,
  layer as providerEventIngestorLayer,
} from "./ProviderEventIngestor.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import { OrchestratorV2, type ClaudeReauthenticationCapture } from "./Orchestrator.ts";
import { ClaudeProviderCapabilitiesV2, CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";

const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claude-reauth-test");
const OTHER_INSTANCE_ID = ProviderInstanceId.make("other-reauth-test");
const CLAUDE_SELECTION = {
  instanceId: CLAUDE_INSTANCE_ID,
  model: "claude-sonnet-4-5",
} satisfies ModelSelection;
const OTHER_SELECTION = {
  instanceId: OTHER_INSTANCE_ID,
  model: "other-model",
} satisfies ModelSelection;
const CLAUDE_DRIVER = CLAUDE_PROVIDER;
const REAUTH_TEXT = "Reply with exactly: auth restored.";
const REAUTH_ATTACHMENT = {
  type: "image",
  id: "claude-reauth-image",
  name: "reauth.png",
  mimeType: "image/png",
  sizeBytes: 4,
} satisfies ChatAttachment;
const REAUTH_CWD = process.cwd();

interface SyntheticAdapterState {
  adapterAvailable?: boolean;
  readonly openedSessionIds: Array<ProviderSessionId>;
  readonly closedSessionIds: Array<ProviderSessionId>;
  readonly startedMessages: Array<{
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }>;
}

const makeProviderThread = (input: {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly nativeId?: string;
  readonly instanceId?: ProviderInstanceId;
}): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(`provider-thread:${input.threadId}`),
  driver: CLAUDE_DRIVER,
  providerInstanceId: input.instanceId ?? CLAUDE_INSTANCE_ID,
  providerSessionId: input.providerSessionId,
  appThreadId: input.threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: CLAUDE_DRIVER,
    nativeId: input.nativeId ?? "synthetic-claude-thread",
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: input.now,
  updatedAt: input.now,
});

const makeSyntheticAdapter = (
  state: SyntheticAdapterState,
  instanceId: ProviderInstanceId = CLAUDE_INSTANCE_ID,
): ProviderAdapterV2Shape => ({
  instanceId,
  driver: CLAUDE_DRIVER,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.closedSessionIds.push(input.providerSessionId);
        }),
      );
      const providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: CLAUDE_DRIVER,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? REAUTH_CWD,
        model: input.modelSelection.model,
        capabilities: ClaudeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      state.openedSessionIds.push(input.providerSessionId);
      return {
        instanceId,
        driver: CLAUDE_DRIVER,
        providerSessionId: input.providerSessionId,
        providerSession,
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          Effect.succeed(
            makeProviderThread({
              threadId: threadInput.threadId,
              providerSessionId: input.providerSessionId,
              instanceId,
              now,
            }),
          ),
        resumeThread: (threadInput) => Effect.succeed(threadInput.providerThread),
        startTurn: (turnInput) =>
          Effect.sync(() => {
            state.startedMessages.push({
              text: turnInput.message.text,
              attachments: turnInput.message.attachments,
            });
          }),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () =>
          Effect.fail(
            new ProviderAdapterProtocolError({
              driver: CLAUDE_DRIVER,
              detail: "readThreadSnapshot is unused by reauthentication tests",
            }),
          ),
        rollbackThread: () =>
          Effect.fail(
            new ProviderAdapterProtocolError({
              driver: CLAUDE_DRIVER,
              detail: "rollbackThread is unused by reauthentication tests",
            }),
          ),
        forkThread: () =>
          Effect.fail(
            new ProviderAdapterProtocolError({
              driver: CLAUDE_DRIVER,
              detail: "forkThread is unused by reauthentication tests",
            }),
          ),
      } satisfies ProviderAdapterV2SessionRuntime;
    }),
});

const makeTestLayer = (state: SyntheticAdapterState) => {
  const providerInstance = {
    instanceId: CLAUDE_INSTANCE_ID,
    driverKind: CLAUDE_DRIVER,
    continuationIdentity: {
      driverKind: CLAUDE_DRIVER,
      continuationKey: "claude:reauth-test",
    },
    displayName: "Claude reauthentication test",
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: makeSyntheticAdapter(state),
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
  const otherProviderInstance = {
    ...providerInstance,
    instanceId: OTHER_INSTANCE_ID,
    continuationIdentity: {
      driverKind: CLAUDE_DRIVER,
      continuationKey: "claude:reauth-other-test",
    },
    displayName: "Other reauthentication test",
    orchestrationAdapter: makeSyntheticAdapter(state, OTHER_INSTANCE_ID),
  } satisfies ProviderInstance;
  const providerRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(
        instanceId === CLAUDE_INSTANCE_ID
          ? state.adapterAvailable === false
            ? undefined
            : providerInstance
          : instanceId === OTHER_INSTANCE_ID
            ? otherProviderInstance
            : undefined,
      ),
    listInstances: Effect.succeed([providerInstance, otherProviderInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-v2-reauth-",
  });
  const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(serverConfigLayer),
    Layer.provide(NodeServices.layer),
  );
  const checkpointStoreLayer = CheckpointStore.layer.pipe(Layer.provide(vcsDriverRegistryLayer));
  const gitWorkflowLayer = Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  });
  const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.none()),
  });
  const providerEventIngestorTestLayer = providerEventIngestorLayer.pipe(
    Layer.provide(
      Layer.merge(
        OrchestrationV2EventSinkLayerLive,
        Layer.merge(
          // The ingestor only reads this store for pending native prompts;
          // EventSink owns the projection instance that applies its writes.
          // Both stores use this same real SQLite persistence layer.
          ProjectionStoreForIngestorLayer,
          IdAllocatorForIngestorLayer,
        ),
      ),
    ),
  );
  return Layer.mergeAll(
    OrchestrationV2LayerLive,
    OrchestrationV2EventSinkLayerLive,
    providerEventIngestorTestLayer,
  ).pipe(
    Layer.provide(mcpSessionRegistryTestLayer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(checkpointStoreLayer),
    Layer.provide(serverConfigLayer),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(providerRegistryLayer),
    Layer.provide(gitWorkflowLayer),
    Layer.provide(projectServiceLayer),
    Layer.provide(NodeServices.layer),
  );
};

// Kept separate from OrchestrationV2LayerLive so the ingestor can be exposed
// to the test while it still writes through the production EventSink layer.
const ProjectionStoreForIngestorLayer = projectionStoreLayer.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const IdAllocatorForIngestorLayer = idAllocatorLayer;

interface FailedTurnFixture {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly messageId: MessageId;
  readonly capture: ClaudeReauthenticationCapture;
}

const makeFailureEvent = (input: {
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly ordinal: number;
  readonly failureClass?: OrchestrationV2ProviderFailureClass;
  readonly failureItemOrdinal?: number;
}): ProviderAdapterV2Event => ({
  type: "turn.terminal",
  driver: CLAUDE_DRIVER,
  providerThreadId: input.providerThreadId,
  providerTurnId: input.providerTurnId,
  runOrdinal: input.ordinal,
  failureItemOrdinal: input.failureItemOrdinal ?? 2,
  status: "failed",
  failure: {
    class: input.failureClass ?? "auth_error",
    message: "Claude authentication expired",
    code: null,
    retryable: null,
  },
  threadDisposition: "reusable",
});

const setupFailedTurn = Effect.fn("setupClaudeReauthenticationFailure")(function* (suffix: string) {
  const orchestrator = yield* OrchestratorV2;
  const eventSink = yield* EventSinkV2;
  const ingestor = yield* ProviderEventIngestorV2;
  const providerSessions = yield* ProviderSessionManagerV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`claude-reauth-thread:${suffix}`);
  const projectId = ProjectId.make(`claude-reauth-project:${suffix}`);
  const messageId = MessageId.make(`claude-reauth-message:${suffix}`);
  const providerTurnId = ProviderTurnId.make(`claude-reauth-turn:${suffix}`);

  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`claude-reauth-thread-create:${suffix}`),
    createdBy: "user",
    creationSource: "web",
    threadId,
    projectId,
    title: "Claude reauthentication",
    modelSelection: CLAUDE_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: REAUTH_CWD,
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`claude-reauth-failed-message:${suffix}`),
    createdBy: "user",
    creationSource: "web",
    threadId,
    messageId,
    text: REAUTH_TEXT,
    attachments: [REAUTH_ATTACHMENT],
    dispatchMode: { type: "defer_start" },
  });
  const preparedProjection = yield* orchestrator.getThreadProjection(threadId);
  const preparedRun = preparedProjection.runs[0];
  const preparedAttempt = preparedProjection.attempts[0];
  const preparedNode = preparedProjection.nodes[0];
  const preparedProviderThread = preparedProjection.providerThreads[0];
  if (
    preparedRun === undefined ||
    preparedAttempt === undefined ||
    preparedNode === undefined ||
    preparedProviderThread === undefined ||
    preparedProviderThread.providerSessionId === null
  ) {
    return yield* Effect.die("Failed to construct the deferred Claude reauthentication run.");
  }
  const runId = preparedRun.id;
  const attemptId = preparedAttempt.id;
  const rootNodeId = preparedNode.id;
  yield* providerSessions.open({
    threadId,
    providerSessionId: preparedProviderThread.providerSessionId,
    modelSelection: CLAUDE_SELECTION,
    runtimePolicy: {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: REAUTH_CWD,
    } satisfies ProviderAdapterV2RuntimePolicy,
  });
  const failure = makeFailureEvent({
    providerThreadId: preparedProviderThread.id,
    providerTurnId,
    ordinal: preparedRun.ordinal,
  });
  yield* ingestor.ingestNormalized({
    providerSessionId: preparedProviderThread.providerSessionId,
    providerInstanceId: CLAUDE_INSTANCE_ID,
    threadId,
    runId,
    nodeId: rootNodeId,
    event: failure,
  });
  const failedRun: OrchestrationV2Run = {
    ...preparedRun,
    status: "failed",
    queuePosition: null,
    startedAt: now,
    completedAt: now,
  };
  const failedAttempt: OrchestrationV2RunAttempt = {
    ...preparedAttempt,
    status: "failed",
    startedAt: now,
    completedAt: now,
  };
  const failedNode: OrchestrationV2ExecutionNode = {
    ...preparedNode,
    status: "failed",
    startedAt: now,
    completedAt: now,
  };
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`claude-reauth-run-failed:${suffix}`),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver: CLAUDE_DRIVER,
        providerInstanceId: CLAUDE_INSTANCE_ID,
        occurredAt: now,
        payload: failedRun,
      },
      {
        id: EventId.make(`claude-reauth-attempt-failed:${suffix}`),
        type: "run-attempt.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver: CLAUDE_DRIVER,
        providerInstanceId: CLAUDE_INSTANCE_ID,
        occurredAt: now,
        payload: failedAttempt,
      },
      {
        id: EventId.make(`claude-reauth-node-failed:${suffix}`),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver: CLAUDE_DRIVER,
        providerInstanceId: CLAUDE_INSTANCE_ID,
        occurredAt: now,
        payload: failedNode,
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>,
  });
  const capture = yield* orchestrator.prepareReauthentication({
    threadId,
    instanceId: CLAUDE_INSTANCE_ID,
  });
  if (capture === null) {
    return yield* Effect.die("Failed Claude auth fixture did not produce a capture.");
  }
  return {
    threadId,
    instanceId: CLAUDE_INSTANCE_ID,
    providerSessionId: preparedProviderThread.providerSessionId,
    providerThreadId: preparedProviderThread.id,
    providerTurnId,
    runId,
    attemptId,
    rootNodeId,
    messageId,
    capture,
  } satisfies FailedTurnFixture;
});

const dispatchNewerRun = Effect.fn("dispatchNewerClaudeReauthenticationRun")(function* (
  threadId: ThreadId,
  suffix: string,
) {
  const orchestrator = yield* OrchestratorV2;
  const messageId = MessageId.make(`claude-reauth-newer-message:${suffix}`);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`claude-reauth-newer-command:${suffix}`),
    createdBy: "user",
    creationSource: "web",
    threadId,
    messageId,
    text: `Newer work ${suffix}`,
    attachments: [],
    dispatchMode: { type: "defer_start" },
  });
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const run = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (run === undefined) {
    return yield* Effect.die("Failed to construct the newer reauthentication run.");
  }
  return run;
});

const updateRunStatus = Effect.fn("updateClaudeReauthenticationRunStatus")(function* (
  run: OrchestrationV2Run,
  status: "running" | "completed",
  suffix: string,
) {
  const eventSink = yield* EventSinkV2;
  const now = yield* DateTime.now;
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`claude-reauth-newer-${status}:${suffix}`),
        type: "run.updated",
        threadId: run.threadId,
        runId: run.id,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        driver: CLAUDE_DRIVER,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...run,
          status,
          queuePosition: null,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      },
    ],
  });
});

it.effect("resumes the captured Claude turn once after releasing its stale session", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    const fixture = yield* setupFailedTurn("positive");
    assert.equal(fixture.capture.text, REAUTH_TEXT);
    assert.deepEqual(fixture.capture.attachments, [REAUTH_ATTACHMENT]);
    assert.equal(fixture.capture.cwd, REAUTH_CWD);
    assert.equal(fixture.capture.providerSessionId, fixture.providerSessionId);
    assert.deepEqual(fixture.capture.modelSelection, CLAUDE_SELECTION);

    assert.equal(yield* orchestrator.continueAfterReauthentication(fixture.capture), "resumed");
    yield* worker.drain();

    const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
    const retry = projection.runs.find((run) => run.id !== fixture.runId);
    assert.isDefined(retry);
    assert.equal(retry.status, "running");
    assert.equal(
      projection.runs.filter((run) => run.userMessageId === retry.userMessageId).length,
      1,
    );
    assert.deepEqual(state.startedMessages, [
      {
        text: REAUTH_TEXT,
        attachments: [REAUTH_ATTACHMENT],
      },
    ]);
    assert.lengthOf(state.openedSessionIds, 2);
    assert.deepEqual(state.closedSessionIds, [fixture.providerSessionId]);

    const staleSession = projection.providerSessions.find(
      (session) => session.id === fixture.providerSessionId,
    );
    assert.isDefined(staleSession);
    assert.equal(staleSession.status, "ready");
  }).pipe(Effect.provide(makeTestLayer(state)));
});

it.effect("skips callbacks whose captured prompt, attachments, cwd, or session is stale", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const fixture = yield* setupFailedTurn("stale-capture");
    const staleCaptures: ReadonlyArray<ClaudeReauthenticationCapture> = [
      { ...fixture.capture, text: "A different prompt" },
      { ...fixture.capture, attachments: [] },
      { ...fixture.capture, cwd: "/tmp/another-worktree" },
      { ...fixture.capture, providerSessionId: null },
    ];

    for (const staleCapture of staleCaptures) {
      assert.equal(yield* orchestrator.continueAfterReauthentication(staleCapture), "skipped");
    }
    assert.deepEqual(state.startedMessages, []);
    assert.deepEqual(state.closedSessionIds, []);
  }).pipe(Effect.provide(makeTestLayer(state)));
});

it.effect("uses the latest root error when deciding whether auth reauthentication applies", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const ingestor = yield* ProviderEventIngestorV2;
    const fixture = yield* setupFailedTurn("latest-error");

    yield* ingestor.ingestNormalized({
      providerSessionId: fixture.providerSessionId,
      providerInstanceId: CLAUDE_INSTANCE_ID,
      threadId: fixture.threadId,
      runId: fixture.runId,
      nodeId: fixture.rootNodeId,
      event: makeFailureEvent({
        providerThreadId: fixture.providerThreadId,
        providerTurnId: ProviderTurnId.make("claude-reauth-latest-provider-error"),
        ordinal: 1,
        failureClass: "provider_error",
        failureItemOrdinal: 3,
      }),
    });

    assert.isNull(
      yield* orchestrator.prepareReauthentication({
        threadId: fixture.threadId,
        instanceId: CLAUDE_INSTANCE_ID,
      }),
    );
    assert.deepEqual(state.startedMessages, []);
  }).pipe(Effect.provide(makeTestLayer(state)));
});

it.effect("skips a captured turn when newer work has taken precedence", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;

    for (const newer of [
      { name: "queued", status: null },
      { name: "running", status: "running" as const },
      { name: "completed", status: "completed" as const },
    ]) {
      const fixture = yield* setupFailedTurn(`newer-${newer.name}`);
      const newerRun = yield* dispatchNewerRun(fixture.threadId, `newer-${newer.name}`);
      if (newer.status !== null) {
        yield* updateRunStatus(newerRun, newer.status, `newer-${newer.name}`);
      }

      assert.equal(yield* orchestrator.continueAfterReauthentication(fixture.capture), "skipped");
      const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
      assert.equal(projection.runs.length, 2);
      assert.equal(
        projection.runs.find((run) => run.id === newerRun.id)?.status,
        newer.status ?? "preparing",
      );
    }

    assert.deepEqual(state.startedMessages, []);
    assert.deepEqual(state.closedSessionIds, []);
  }).pipe(Effect.provide(makeTestLayer(state)));
});

it.effect("skips a captured turn after its thread is archived", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const fixture = yield* setupFailedTurn("archived");

    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("claude-reauth-archive"),
      threadId: fixture.threadId,
    });

    assert.equal(yield* orchestrator.continueAfterReauthentication(fixture.capture), "skipped");
    const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
    assert.isNotNull(projection.thread.archivedAt);
    assert.lengthOf(projection.runs, 1);
    assert.deepEqual(state.startedMessages, []);
  }).pipe(Effect.provide(makeTestLayer(state)));
});

it.effect("skips a captured turn after its provider is switched", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const fixture = yield* setupFailedTurn("provider-switch");

    yield* orchestrator.dispatch({
      type: "provider.switch",
      commandId: CommandId.make("claude-reauth-provider-switch"),
      threadId: fixture.threadId,
      modelSelection: OTHER_SELECTION,
    });

    assert.equal(yield* orchestrator.continueAfterReauthentication(fixture.capture), "skipped");
    const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
    assert.equal(projection.thread.providerInstanceId, OTHER_INSTANCE_ID);
    assert.deepEqual(projection.thread.modelSelection, OTHER_SELECTION);
    assert.lengthOf(projection.runs, 1);
    assert.deepEqual(state.startedMessages, []);
  }).pipe(Effect.provide(makeTestLayer(state)));
});

it.effect("skips a captured turn after its same-provider model is switched", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const fixture = yield* setupFailedTurn("model-switch");

    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("claude-reauth-model-switch"),
      threadId: fixture.threadId,
      modelSelection: {
        instanceId: CLAUDE_INSTANCE_ID,
        model: "claude-opus-4-5",
      },
    });

    assert.equal(yield* orchestrator.continueAfterReauthentication(fixture.capture), "skipped");
    const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
    assert.deepEqual(projection.thread.modelSelection, {
      instanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-5",
    });
    assert.lengthOf(projection.runs, 1);
    assert.deepEqual(state.startedMessages, []);
  }).pipe(Effect.provide(makeTestLayer(state)));
});

it.effect("uses a fresh retry command after a rejected dispatch receipt", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    const fixture = yield* setupFailedTurn("rejected-retry");

    // Make the first retry fail during command planning. The capture remains
    // current, so a later OAuth callback should be able to try again.
    state.adapterAvailable = false;
    const firstAttempt = yield* Effect.exit(
      orchestrator.continueAfterReauthentication(fixture.capture),
    );
    assert.isTrue(Exit.isFailure(firstAttempt));

    state.adapterAvailable = true;
    assert.equal(yield* orchestrator.continueAfterReauthentication(fixture.capture), "resumed");
    yield* worker.drain();

    const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
    assert.lengthOf(projection.runs, 2);
    assert.deepEqual(state.startedMessages, [
      {
        text: REAUTH_TEXT,
        attachments: [REAUTH_ATTACHMENT],
      },
    ]);
  }).pipe(Effect.provide(makeTestLayer(state)));
});

it.effect("makes duplicate Claude reauthentication callbacks idempotent", () => {
  const state: SyntheticAdapterState = {
    openedSessionIds: [],
    closedSessionIds: [],
    startedMessages: [],
  };
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    const fixture = yield* setupFailedTurn("duplicate");

    assert.equal(yield* orchestrator.continueAfterReauthentication(fixture.capture), "resumed");
    yield* worker.drain();
    assert.equal(yield* orchestrator.continueAfterReauthentication(fixture.capture), "skipped");

    const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
    assert.lengthOf(projection.runs, 2);
    assert.lengthOf(state.startedMessages, 1);
    assert.deepEqual(state.closedSessionIds, [fixture.providerSessionId]);
  }).pipe(Effect.provide(makeTestLayer(state)));
});

import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for record controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "secret-request-record" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const projectId = ProjectId.make("project:secret-request-record");
const threadId = ThreadId.make("thread:secret-request-record");
const sessionId = ProviderSessionId.make("session:secret-request-record");
const providerThreadId = ProviderThreadId.make("provider-thread:secret-request-record");
const runId = RunId.make("run:secret-request-record");
const firstAttemptId = RunAttemptId.make("attempt:secret-request-record:1");
const steeredAttemptId = RunAttemptId.make("attempt:secret-request-record:2");
const originalRoot = NodeId.make("node:secret-request-record:original");
const steeredRoot = NodeId.make("node:secret-request-record:steered");
const originalTurnId = ProviderTurnId.make("provider-turn:secret-request-record:original");
const messageId = MessageId.make("message:secret-request-record");
const cardId = TurnItemId.make("turn-item:secret-request:secret-request-record");
const staleCardId = TurnItemId.make("turn-item:secret-request:secret-request-record:stale");
const now = DateTime.makeUnsafe("2026-11-11T20:00:00.000Z");

/**
 * A pending secret card must stay closable after a steering restart replaces the
 * run's root node: the call that opened it only ever carries the card's own node,
 * so rejecting that node wedges the card open forever.
 */
it.effect("closes a secret card recorded under an earlier root after a steering restart", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-secret-request-record"),
      threadId,
      projectId,
      title: "Secret request record",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("secret-request-record:session"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("secret-request-record:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: adapter.driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projections.apply({
      id: EventId.make("secret-request-record:run"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: originalRoot,
        activeAttemptId: firstAttemptId,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("secret-request-record:attempt-1"),
      type: "run-attempt.created",
      threadId,
      occurredAt: now,
      payload: {
        id: firstAttemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: originalRoot,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    // The first attempt reached the provider; the card is asked on that turn.
    yield* projections.apply({
      id: EventId.make("secret-request-record:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: originalTurnId,
        providerThreadId,
        nodeId: originalRoot,
        runAttemptId: firstAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    const record = (commandId: string, nodeId: NodeId, turnItemId: TurnItemId) =>
      orchestrator.dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(commandId),
        threadId,
        runId,
        nodeId,
        turnItemId,
        label: "Booking details",
        reason: "To check the passenger in.",
        secretStatus: "pending" as const,
      });
    const readCard = (id: TurnItemId) =>
      projections
        .getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.map((records) => {
            const item = records.turnItems.find((candidate) => candidate.id === id);
            return item?.type === "secret_request" ? item : undefined;
          }),
        );

    yield* record("secret-request-record:open", originalRoot, cardId);
    const opened = yield* readCard(cardId);
    assert.equal(opened?.secretStatus, "pending");
    assert.equal(opened?.providerTurnId, originalTurnId);

    // The user steers while the card waits: the run's root moves to a new attempt.
    yield* projections.apply({
      id: EventId.make("secret-request-record:run-steered"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: steeredRoot,
        activeAttemptId: steeredAttemptId,
        status: "starting",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("secret-request-record:attempt-2"),
      type: "run-attempt.created",
      threadId,
      occurredAt: now,
      payload: {
        id: steeredAttemptId,
        runId,
        attemptOrdinal: 2,
        rootNodeId: steeredRoot,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "steering_restart",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    });

    // The waiting call only carries the card's own node; closing must still work.
    yield* orchestrator.dispatch({
      type: "secret_request.record",
      commandId: CommandId.make("secret-request-record:close"),
      threadId,
      runId,
      nodeId: originalRoot,
      turnItemId: cardId,
      label: "Booking details",
      reason: "To check the passenger in.",
      secretStatus: "cancelled" as const,
    });
    const cancelled = yield* readCard(cardId);
    assert.equal(cancelled?.secretStatus, "cancelled");
    assert.equal(cancelled?.status, "cancelled");
    // Closing through the card's own node keeps the identity it was asked with,
    // even though the run's active attempt has no provider turn of its own.
    assert.equal(cancelled?.nodeId, originalRoot);
    assert.equal(cancelled?.providerTurnId, originalTurnId);

    // A new card may not be opened under the stale root.
    const stale = yield* Effect.flip(
      record("secret-request-record:stale-open", originalRoot, staleCardId),
    );
    assert.match(String((stale as { cause?: unknown }).cause ?? ""), /is not the root of run/);
  }).pipe(Effect.provide(layerTest)),
);

import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EffectOutboxV2, layer as effectOutboxLayer } from "./EffectOutbox.ts";
import { OrchestratorDispatchError, OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  effectOutboxLayer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect("interrupts only the selected running native Codex subagent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const outbox = yield* EffectOutboxV2;
    const parentThreadId = ThreadId.make("parent:stop-subagent");
    const childThreadId = ThreadId.make("child:stop-subagent");
    const subagentId = NodeId.make("subagent:stop-subagent");
    const providerThreadId = ProviderThreadId.make("provider-thread:stop-subagent");
    const providerTurnId = ProviderTurnId.make("provider-turn:stop-subagent");
    const providerSessionId = ProviderSessionId.make("session:stop-subagent");
    const now = yield* DateTime.now;
    for (const threadId of [parentThreadId, childThreadId]) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:stop-subagent"),
        title: "Agent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    const subagent = {
      id: subagentId,
      threadId: parentThreadId,
      runId: null,
      parentNodeId: NodeId.make("root:stop-subagent"),
      origin: "provider_native" as const,
      createdBy: "agent" as const,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId,
      nativeTaskRef: null,
      prompt: "Check this",
      title: "Worker",
      model: "gpt-5.1-codex",
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* projections.apply({
      id: EventId.make("subagent:stop-subagent"),
      type: "subagent.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: subagent,
    });
    yield* projections.apply({
      id: EventId.make("provider-thread:stop-subagent"),
      type: "provider-thread.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId,
        appThreadId: childThreadId,
        ownerNodeId: subagentId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projections.apply({
      id: EventId.make("provider-turn:stop-subagent"),
      type: "provider-turn.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId: NodeId.make("root:child-stop-subagent"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    const commandId = CommandId.make("interrupt:stop-subagent");
    const accepted = yield* orchestrator.dispatch({
      type: "subagent.interrupt",
      commandId,
      threadId: parentThreadId,
      subagentId,
    });
    assert.deepEqual(
      accepted.storedEvents.map((event) => event.event.type),
      ["subagent.interrupt-requested"],
    );
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).subagents[0]?.status,
      "running",
    );
    assert.deepEqual(
      (yield* outbox.listByCommandId(commandId)).map(({ threadId, request }) => ({
        threadId,
        request,
      })),
      [
        {
          threadId: childThreadId,
          request: {
            type: "provider-turn.interrupt",
            providerSessionId,
            providerThreadId,
            providerTurnId,
          },
        },
      ],
    );
    yield* projections.apply({
      id: EventId.make("subagent:stop-subagent:completed"),
      type: "subagent.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: { ...subagent, status: "completed", completedAt: now },
    });
    const settledCommandId = CommandId.make("interrupt:stop-subagent:settled");
    const rejected = yield* orchestrator
      .dispatch({
        type: "subagent.interrupt",
        commandId: settledCommandId,
        threadId: parentThreadId,
        subagentId,
      })
      .pipe(Effect.flip);
    assert.instanceOf(rejected, OrchestratorDispatchError);
    assert.equal(rejected.cause, undefined);
    assert.deepEqual(yield* outbox.listByCommandId(settledCommandId), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                decision: "accept",
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(testLayer)),
);

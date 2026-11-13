import { assert, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  CommandId,
  CheckpointId,
  ContextTransferId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadShellSnapshot,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type ThreadPullRequestLink,
  isLiveSubagentShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import { layerReaderDatabase, traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";

import {
  layerTest,
  modelSelection,
  driver,
  providerInstanceId,
} from "./ProjectionStore-fixtures.testkit.ts";

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("removes rolled back runs from the active visible projection", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-rollback-prune");
      const projectId = ProjectId.make("project:projection-rollback-prune");
      const runId = RunId.make("run:projection-rollback-prune");
      const attemptId = RunAttemptId.make("attempt:projection-rollback-prune");
      const rootNodeId = NodeId.make("node:projection-rollback-prune:root");
      const assistantNodeId = NodeId.make("node:projection-rollback-prune:assistant");
      const providerThreadId = ProviderThreadId.make("provider-thread:projection-rollback-prune");
      const providerTurnId = ProviderTurnId.make("provider-turn:projection-rollback-prune");
      const userMessageId = MessageId.make("message:projection-rollback-prune:user");
      const assistantMessageId = MessageId.make("message:projection-rollback-prune:assistant");
      const userTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:user");
      const assistantTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:assistant");
      const backgroundTurnItemId = TurnItemId.make(
        "turn-item:projection-rollback-prune:background",
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection rollback prune",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-created"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:attempt-created"),
        type: "run-attempt.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantNodeId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          rootNodeId,
          kind: "assistant_message",
          status: "completed",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userMessageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "rolled back user",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id: assistantMessageId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          role: "assistant",
          text: "rolled back assistant",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 100,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: userMessageId,
          inputIntent: "turn_start",
          text: "rolled back user",
          attachments: [],
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantTurnItemId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: assistantMessageId,
          text: "rolled back assistant",
          streaming: false,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:background-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: backgroundTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 300,
          status: "running",
          title: "rolled back background command",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "sleep 60",
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-rolled-back"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-rolled-back"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "rolled_back",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["rolled_back"],
      );
      assert.deepEqual(
        projection.nodes.map((node) => [node.id, node.status]),
        [
          [assistantNodeId, "completed"],
          [rootNodeId, "rolled_back"],
        ],
      );
      assert.lengthOf(projection.providerTurns, 1);
      assert.lengthOf(projection.messages, 2);
      assert.lengthOf(projection.turnItems, 3);
      assert.lengthOf(projection.visibleTurnItems, 0);

      const shell = yield* projectionStore.getShellSnapshot();
      const rolledBackShellThread = shell.threads.find((entry) => entry.id === threadId);
      assert.isDefined(rolledBackShellThread);
      assert.isNull(rolledBackShellThread.latestVisibleMessage);
      assert.deepEqual(rolledBackShellThread?.pendingBackgroundTasks ?? [], []);
    }),
  );
});

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
  TurnItemId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("rejects a planned fork whose source was deleted before it committed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const sourceId = ThreadId.make("fork-source");
    const targetId = ThreadId.make("fork-target");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const source: OrchestrationV2AppThread = {
      id: sourceId,
      projectId: ProjectId.make("project"),
      title: "Source",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: sourceId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-created"),
          type: "thread.created",
          threadId: sourceId,
          occurredAt: now,
          payload: source,
        },
      ],
    });
    const plannedFork = {
      commandId: CommandId.make("fork"),
      commandType: "thread.fork",
      threadId: targetId,
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("fork-created"),
          type: "thread.created" as const,
          threadId: targetId,
          occurredAt: now,
          payload: {
            ...source,
            id: targetId,
            forkedFrom: { type: "run" as const, threadId: sourceId, runId: RunId.make("run") },
          },
        },
      ],
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...source, deletedAt: now },
        },
      ],
    });
    const rejected = yield* sink.commitCommand(plannedFork);
    assert.equal(rejected.receipt.status, "rejected");
    assert.isFalse(rejected.committed);
    const replayed = yield* sink.commitCommand(plannedFork);
    assert.deepEqual(replayed.receipt, rejected.receipt);
    assert.isFalse(replayed.committed);
    const missing = yield* projections.getThread(targetId).pipe(Effect.flip);
    assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "pins late cross-run tool updates to their original run across events, positions, and projections",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const t1 = DateTime.makeUnsafe("2026-11-23T07:35:02.491Z");
      const tHoldExpiry = DateTime.makeUnsafe("2026-11-23T08:05:25.578Z");
      const t2 = DateTime.makeUnsafe("2026-11-23T08:06:35.735Z");
      const threadId = ThreadId.make("thread:sink-tool-pin");
      const run1Id = RunId.make("run:sink-tool-pin:1");
      const run2Id = RunId.make("run:sink-tool-pin:2");
      const root1Id = NodeId.make("node:sink-tool-pin:root-1");
      const root2Id = NodeId.make("node:sink-tool-pin:root-2");
      const toolNodeId = NodeId.make("node:sink-tool-pin:tool-1");
      const toolItemId = TurnItemId.make("item:sink-tool-pin:tool-1");
      const run2ToolItemId = TurnItemId.make("item:sink-tool-pin:tool-2");
      const todoNodeId = NodeId.make("node:sink-tool-pin:todo-1");
      const steerItemId = TurnItemId.make("item:sink-tool-pin:steer-1");
      const driver = ProviderDriverKind.make("antigravity");
      const providerInstanceId = ProviderInstanceId.make("antigravity");
      const modelSelection = { instanceId: providerInstanceId, model: "gemini-4" };
      const providerThreadId = ProviderThreadId.make("provider-thread:sink-tool-pin");
      const turn1Id = ProviderTurnId.make("provider-turn:sink-tool-pin:1");
      const turn2Id = ProviderTurnId.make("provider-turn:sink-tool-pin:2");

      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project"),
        title: "Sink tool pin",
        createdBy: "user",
        creationSource: "web",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThreadId,
        lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
        forkedFrom: null,
        createdAt: t1,
        updatedAt: t1,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        lastVisitedAt: null,
      };
      const makeRun = (
        id: RunId,
        ordinal: number,
        rootNodeId: NodeId,
        status: "completed" | "running",
        at: DateTime.Utc,
      ) => ({
        id: EventId.make(`event:sink-tool-pin:run-${ordinal}`),
        type: "run.created" as const,
        threadId,
        runId: id,
        driver,
        providerInstanceId,
        occurredAt: at,
        payload: {
          id,
          threadId,
          ordinal,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:sink-tool-pin:${ordinal}`),
          rootNodeId,
          activeAttemptId: null,
          status,
          requestedAt: at,
          startedAt: at,
          completedAt: status === "completed" ? at : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const initial = yield* sink.write({
        events: [
          {
            id: EventId.make("event:sink-tool-pin:thread"),
            type: "thread.created",
            threadId,
            occurredAt: t1,
            payload: thread,
          },
          makeRun(run1Id, 1, root1Id, "running", t1),
          {
            id: EventId.make("event:sink-tool-pin:node-1"),
            type: "node.updated",
            threadId,
            runId: run1Id,
            nodeId: toolNodeId,
            driver,
            occurredAt: t1,
            payload: {
              id: toolNodeId,
              threadId,
              runId: run1Id,
              parentNodeId: root1Id,
              rootNodeId: root1Id,
              kind: "tool_call",
              status: "running",
              countsForRun: true,
              providerThreadId,
              providerTurnId: turn1Id,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: t1,
              completedAt: null,
            },
          },
          {
            id: EventId.make("event:sink-tool-pin:item-1"),
            type: "turn-item.updated",
            threadId,
            runId: run1Id,
            nodeId: toolNodeId,
            driver,
            occurredAt: t1,
            payload: {
              id: toolItemId,
              type: "command_execution",
              threadId,
              runId: run1Id,
              nodeId: toolNodeId,
              providerThreadId,
              providerTurnId: turn1Id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "Running command",
              startedAt: t1,
              completedAt: null,
              updatedAt: t1,
              input: "fnm use 24",
            },
          },
          {
            id: EventId.make("event:sink-tool-pin:todo-node-1"),
            type: "node.updated",
            threadId,
            runId: run1Id,
            nodeId: todoNodeId,
            driver,
            occurredAt: t1,
            payload: {
              id: todoNodeId,
              threadId,
              runId: run1Id,
              parentNodeId: root1Id,
              rootNodeId: root1Id,
              kind: "todo_list",
              status: "running",
              countsForRun: false,
              providerThreadId,
              providerTurnId: turn1Id,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: t1,
              completedAt: null,
            },
          },
          {
            id: EventId.make("event:sink-tool-pin:steer-1"),
            type: "turn-item.updated",
            threadId,
            runId: run1Id,
            occurredAt: t1,
            payload: {
              id: steerItemId,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              threadId,
              runId: run1Id,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "pending",
              title: null,
              startedAt: t1,
              completedAt: null,
              updatedAt: t1,
              messageId: MessageId.make("message:sink-tool-pin:steer"),
              inputIntent: "steer",
              text: "follow up",
              attachments: [],
            },
          },
        ],
      });
      const initialItemEvent = initial.find(
        (stored) =>
          stored.event.type === "turn-item.updated" && stored.event.payload.id === toolItemId,
      );
      if (initialItemEvent?.event.type !== "turn-item.updated") {
        assert.fail("Expected initial turn-item.updated event");
      }
      const originalOrdinal = initialItemEvent.event.payload.ordinal;
      assert.equal(originalOrdinal, 1_000_001);

      // Normal same-run update writes status/output and keeps the existing ordinal.
      const sameRunUpdated = yield* sink.write({
        events: [
          {
            id: EventId.make("event:sink-tool-pin:item-1-completed"),
            type: "turn-item.updated",
            threadId,
            runId: run1Id,
            nodeId: toolNodeId,
            driver,
            occurredAt: tHoldExpiry,
            payload: {
              id: toolItemId,
              type: "command_execution",
              threadId,
              runId: run1Id,
              nodeId: toolNodeId,
              providerThreadId,
              providerTurnId: turn1Id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 99,
              status: "completed",
              title: "Ran command",
              startedAt: t1,
              completedAt: tHoldExpiry,
              updatedAt: tHoldExpiry,
              input: "fnm use 24",
              output: "fnm list",
            },
          },
          {
            ...makeRun(run1Id, 1, root1Id, "completed", tHoldExpiry),
            id: EventId.make("event:sink-tool-pin:run-1-completed"),
            type: "run.updated",
          },
          makeRun(run2Id, 2, root2Id, "running", t2),
        ],
      });
      const sameRunItem = sameRunUpdated[0]?.event;
      if (
        sameRunItem?.type !== "turn-item.updated" ||
        sameRunItem.payload.type !== "command_execution"
      ) {
        assert.fail("Expected same-run command_execution update");
      }
      assert.equal(sameRunItem.payload.ordinal, originalOrdinal);
      assert.equal(sameRunItem.payload.status, "completed");
      assert.equal(sameRunItem.payload.output, "fnm list");

      // Late cross-run tool updates stay pinned to Run 1; non-tool nodes/items still move to Run 2.
      const lateCommitted = yield* sink.write({
        events: [
          {
            id: EventId.make("event:sink-tool-pin:node-2"),
            type: "node.updated",
            threadId,
            runId: run2Id,
            nodeId: toolNodeId,
            driver,
            occurredAt: t2,
            payload: {
              id: toolNodeId,
              threadId,
              runId: run2Id,
              parentNodeId: root2Id,
              rootNodeId: root2Id,
              kind: "tool_call",
              status: "failed",
              countsForRun: true,
              providerThreadId,
              providerTurnId: turn2Id,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: t2,
              completedAt: t2,
            },
          },
          {
            id: EventId.make("event:sink-tool-pin:item-2"),
            type: "turn-item.updated",
            threadId,
            runId: run2Id,
            nodeId: toolNodeId,
            driver,
            occurredAt: t2,
            payload: {
              id: toolItemId,
              type: "command_execution",
              threadId,
              runId: run2Id,
              nodeId: toolNodeId,
              providerThreadId,
              providerTurnId: turn2Id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 6,
              status: "failed",
              title: "Ran command",
              startedAt: t2,
              completedAt: t2,
              updatedAt: t2,
              input: "fnm use 24",
              output: "killed",
            },
          },
          {
            id: EventId.make("event:sink-tool-pin:item-2-null-run"),
            type: "turn-item.updated",
            threadId,
            nodeId: toolNodeId,
            driver,
            occurredAt: t2,
            payload: {
              id: toolItemId,
              type: "command_execution",
              threadId,
              runId: null,
              nodeId: toolNodeId,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 7,
              status: "failed",
              title: "Ran command",
              startedAt: t2,
              completedAt: t2,
              updatedAt: t2,
              input: "fnm use 24",
              output: "killed (runless)",
            },
          },
          {
            id: EventId.make("event:sink-tool-pin:todo-node-2"),
            type: "node.updated",
            threadId,
            runId: run2Id,
            nodeId: todoNodeId,
            driver,
            occurredAt: t2,
            payload: {
              id: todoNodeId,
              threadId,
              runId: run2Id,
              parentNodeId: root2Id,
              rootNodeId: root2Id,
              kind: "todo_list",
              status: "completed",
              countsForRun: false,
              providerThreadId,
              providerTurnId: turn2Id,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: t1,
              completedAt: t2,
            },
          },
          {
            id: EventId.make("event:sink-tool-pin:steer-2"),
            type: "turn-item.updated",
            threadId,
            runId: run2Id,
            occurredAt: t2,
            payload: {
              id: steerItemId,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              threadId,
              runId: run2Id,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: t1,
              completedAt: t2,
              updatedAt: t2,
              messageId: MessageId.make("message:sink-tool-pin:steer"),
              inputIntent: "steer",
              text: "follow up",
              attachments: [],
            },
          },
          {
            id: EventId.make("event:sink-tool-pin:run2-own-tool"),
            type: "turn-item.updated",
            threadId,
            runId: run2Id,
            driver,
            occurredAt: t2,
            payload: {
              id: run2ToolItemId,
              type: "command_execution",
              threadId,
              runId: run2Id,
              nodeId: null,
              providerThreadId,
              providerTurnId: turn2Id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "completed",
              title: "Ran command",
              startedAt: t2,
              completedAt: t2,
              updatedAt: t2,
              input: "git push",
            },
          },
        ],
      });

      // Committed/broadcast events keep Run 1's ownership and ordinal so live clients never move the item.
      const lateNode = lateCommitted[0]?.event;
      const lateItem = lateCommitted[1]?.event;
      const lateNullRunItem = lateCommitted[2]?.event;
      const movedTodoNode = lateCommitted[3]?.event;
      const movedSteerItem = lateCommitted[4]?.event;
      const run2OwnItem = lateCommitted[5]?.event;
      if (lateNode?.type !== "node.updated") {
        assert.fail("Expected late node.updated event");
      }
      assert.equal(lateNode.runId, run1Id);
      assert.equal(lateNode.payload.runId, run1Id);
      assert.equal(lateNode.payload.parentNodeId, root1Id);
      assert.equal(lateNode.payload.rootNodeId, root1Id);
      assert.equal(lateNode.payload.providerTurnId, turn1Id);
      assert.deepEqual(lateNode.payload.startedAt, t1);
      assert.equal(lateNode.payload.status, "failed");

      if (lateItem?.type !== "turn-item.updated") {
        assert.fail("Expected late turn-item.updated event");
      }
      assert.equal(lateItem.runId, run1Id);
      assert.equal(lateItem.payload.runId, run1Id);
      assert.equal(lateItem.payload.providerTurnId, turn1Id);
      assert.equal(lateItem.payload.ordinal, originalOrdinal);
      assert.deepEqual(lateItem.payload.startedAt, t1);
      assert.equal(lateItem.payload.status, "failed");

      if (lateNullRunItem?.type !== "turn-item.updated") {
        assert.fail("Expected late null-run turn-item.updated event");
      }
      assert.equal(lateNullRunItem.runId, run1Id);
      assert.equal(lateNullRunItem.payload.runId, run1Id);
      assert.equal(lateNullRunItem.payload.providerTurnId, turn1Id);
      assert.equal(lateNullRunItem.payload.ordinal, originalOrdinal);
      assert.deepEqual(lateNullRunItem.payload.startedAt, t1);

      // Non-tool nodes and missed steers still migrate into Run 2.
      if (movedTodoNode?.type !== "node.updated") {
        assert.fail("Expected moved todo_list node.updated event");
      }
      assert.equal(movedTodoNode.payload.runId, run2Id);
      assert.equal(movedTodoNode.payload.rootNodeId, root2Id);

      if (movedSteerItem?.type !== "turn-item.updated") {
        assert.fail("Expected moved steer turn-item.updated event");
      }
      assert.equal(movedSteerItem.payload.runId, run2Id);
      assert.equal(movedSteerItem.payload.ordinal, 2_000_001);

      // Run 2's own lifecycle and ordinal allocation stay unaffected.
      if (run2OwnItem?.type !== "turn-item.updated") {
        assert.fail("Expected Run 2 own tool item event");
      }
      assert.equal(run2OwnItem.payload.runId, run2Id);
      assert.equal(run2OwnItem.payload.ordinal, 2_000_002);

      // Position table and per-run item counts are not skewed into Run 2.
      const positions = yield* sql<{ readonly ordinal: number }>`
        SELECT ordinal
        FROM orchestration_v2_turn_item_positions
        WHERE thread_id = ${threadId} AND turn_item_id = ${toolItemId}
      `;
      assert.deepEqual(positions, [{ ordinal: originalOrdinal }]);

      const countRows = yield* sql<{
        readonly run_key: string;
        readonly item_count: number;
      }>`
        SELECT run_key, item_count
        FROM orchestration_v2_projection_turn_item_counts
        WHERE thread_id = ${threadId}
        ORDER BY run_key
      `;
      assert.deepEqual(countRows, [
        { run_key: run1Id, item_count: 1 },
        { run_key: run2Id, item_count: 2 },
      ]);

      // Projected read matches and Run 2 remains active.
      const projection = yield* projections.getThreadProjection(threadId);
      const item = projection.turnItems.find((candidate) => candidate.id === toolItemId);
      assert.equal(item?.runId, run1Id);
      assert.equal(item?.ordinal, originalOrdinal);
      assert.equal(item?.status, "failed");
      assert.equal(item?.type === "command_execution" ? item.output : null, "killed (runless)");
      assert.equal(projection.runs.find((run) => run.id === run2Id)?.status, "running");
    }).pipe(Effect.provide(layer)),
);

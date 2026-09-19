import { assert, it, vi } from "@effect/vitest";
import {
  EventId,
  CommandId,
  CheckpointId,
  ComposerContextId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  type ModelSelection,
  NodeId,
  OrchestrationV2TurnItemJson,
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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  boundedPayloadPreviewJson,
  jsonDepthExceeds,
  THREAD_HISTORY_PREVIEW_HARD_DEPTH,
} from "./boundedPayloadPreview.ts";
import {
  isTurnItemAtOrBeforeRun,
  layerMemory as projectionStoreMemoryLayer,
  threadShellFromProjection,
  ProjectionStoreV2,
  ProjectionStoreThreadNotFoundError,
  layer as projectionStoreLayer,
} from "./ProjectionStore.ts";
import {
  buildBoundedThreadProjection,
  bytesOfJson,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_COMPACTED_FIELD_CHARS,
  THREAD_HISTORY_CURSOR_MAX_LENGTH,
  THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES,
  THREAD_HISTORY_MAX_WINDOW_BYTES,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";

const TestLayer = Layer.mergeAll(
  projectionStoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Surrogate-id fixtures leave bound id columns (run_id, turn_item_id, node_id,
// message_id) holding driver-folded or raw WTF-8 bytes. The suite shares one
// database per file and shell paths re-decode every row's id columns — under
// bun:sqlite a WTF-8 column reads back as '' and fails branded-id
// construction — so each fixture purges its rows after exercising the
// bounded path.
const purgeProjectionRows = Effect.fn("purgeProjectionRows")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id IN ${sql.in(threadIds)}`;
  yield* sql`DELETE FROM orchestration_v2_projection_nodes WHERE thread_id IN ${sql.in(threadIds)}`;
  yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id IN ${sql.in(threadIds)}`;
  yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE thread_id IN ${sql.in(threadIds)}`;
  yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id IN ${sql.in(threadIds)}`;
});

// v2 cursors anchor by ordinal plus a digest of the source thread id so
// unbounded ids stay out of the cursor; v1 keeps resolving verbatim ids.
const anchorWindowOptions = (cursor: string) => {
  const anchor = decodeThreadHistoryCursor(cursor);
  return anchor.v === 2
    ? {
        anchorOrdinal: anchor.so,
        anchorThreadDigest: anchor.sth,
        anchorItemDigest: anchor.sih,
      }
    : { anchorThreadId: ThreadId.make(anchor.st), anchorItemId: TurnItemId.make(anchor.si) };
};

const addRolledBackRecoveryCandidate = Effect.fn("addRolledBackRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:rolled-back`);
  const runId = RunId.make(`run:${suffix}:rolled-back`);
  const rootNodeId = NodeId.make(`node:${suffix}:rolled-back`);
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${suffix}:rolled-back`),
    rootNodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Rolled-back recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
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
    id: EventId.make(`event:${suffix}:run-created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: run,
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:rolled-back`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "abandoned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-rolled-back`),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: { ...run, status: "rolled_back", completedAt: now },
  });

  return threadId;
});

// Seeds ten command_execution items where the index-4 and index-5 items share
// ordinal 5: several producers allocate ordinals independently, so ordinals
// are not unique and cursor anchors must disambiguate equal-ordinal siblings.
const seedDuplicateOrdinalThread = Effect.fn("seedDuplicateOrdinalThread")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const nowIso = DateTime.formatIso(now);
  const threadId = ThreadId.make(`thread:${suffix}`);
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Duplicate ordinal window",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
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
  const allIds: Array<string> = [];
  const rows = Array.from({ length: 10 }, (_, index) => {
    const id = `item:${suffix}:${index}`;
    allIds.push(id);
    const ordinal = index === 5 ? 5 : index + 1;
    const item = {
      type: "command_execution",
      id,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output: `out-${index}`,
      exitCode: 0,
      startedAt: nowIso,
      completedAt: nowIso,
      updatedAt: nowIso,
    };
    return {
      turn_item_id: id,
      thread_id: threadId,
      run_id: null,
      node_id: null,
      provider_thread_id: null,
      provider_turn_id: null,
      parent_item_id: null,
      ordinal,
      type: item.type,
      status: "completed",
      updated_at: nowIso,
      payload_json: encodeUnknownJsonString(item),
    };
  });
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
  return { threadId, allIds };
});

const addOrphanedRecoveryCandidate = Effect.fn("addOrphanedRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:orphaned`);
  const runId = RunId.make(`run:${suffix}:missing`);
  const rootNodeId = NodeId.make(`node:${suffix}:orphaned`);

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Orphaned recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
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
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:orphaned`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "orphaned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });

  return threadId;
});

it("includes imported runless history when selecting fork context through a run", () => {
  const firstRunId = RunId.make("run:projection-imported-fork:1");
  const secondRunId = RunId.make("run:projection-imported-fork:2");
  const runOrdinalById = new Map([
    [firstRunId, 1],
    [secondRunId, 2],
  ]);

  assert.isTrue(
    isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: null,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isFalse(
    isTurnItemAtOrBeforeRun({
      historyOrigin: undefined,
      itemRunId: null,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isTrue(
    isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: firstRunId,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isFalse(
    isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: secondRunId,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
});

it.effect("memory recovery selection ignores unfinished items from rolled-back runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("memory-recovery-candidates");

    assert.notInclude(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory recovery selection includes unfinished items from missing runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const threadId = yield* addOrphanedRecoveryCandidate("memory-recovery-candidates");

    assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory snapshot windows bound every payload collection, not just turn items", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:memory-bounded-collections");
    const hugeTitle = "t".repeat(200_000);
    const hugeMessage = "m".repeat(200_000);
    yield* projectionStore.apply({
      id: EventId.make("event:memory-bounded-collections:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:memory-bounded-collections"),
        title: hugeTitle,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
      id: EventId.make("event:memory-bounded-collections:message"),
      type: "message.updated",
      threadId,
      driver,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: MessageId.make("message:memory-bounded-collections"),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: hugeMessage,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    // The window hydrates only collections the retained items reference, so the
    // message needs a turn item pointing at it to stay in the cohort.
    yield* projectionStore.apply({
      id: EventId.make("event:memory-bounded-collections:item"),
      type: "turn-item.updated",
      threadId,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:memory-bounded-collections"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "assistant_message",
        messageId: MessageId.make("message:memory-bounded-collections"),
        text: "see message",
        attachments: [],
        streaming: false,
      },
    });

    const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 75,
    });
    assert.isBelow(windowed.projection.thread.title.length, hugeTitle.length);
    assert.isBelow(windowed.projection.messages[0]!.text.length, hugeMessage.length);
    // Compaction runs on decoded values here — non-plain objects like
    // DateTime must pass through whole rather than be rebuilt member-wise.
    assert.isTrue(DateTime.isDateTime(windowed.projection.thread.createdAt));
    assert.isTrue(DateTime.isDateTime(windowed.projection.messages[0]!.createdAt));

    const full = yield* projectionStore.getThreadProjection(threadId);
    assert.strictEqual(full.thread.title, hugeTitle);
    assert.strictEqual(full.messages[0]!.text, hugeMessage);
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory snapshot windows retain the newest stored row as the watermark", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:memory-watermark");
    const runId = RunId.make("run:memory-watermark:rolled-back");
    const rootNodeId = NodeId.make("node:memory-watermark");
    yield* projectionStore.apply({
      id: EventId.make("event:memory-watermark:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:memory-watermark"),
        title: "memory watermark",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message:memory-watermark"),
      rootNodeId,
      activeAttemptId: null,
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* projectionStore.apply({
      id: EventId.make("event:memory-watermark:run"),
      type: "run.created",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: run,
    });
    const applyItem = (ordinal: number, itemRunId: RunId | null) =>
      projectionStore.apply({
        id: EventId.make(`event:memory-watermark:item-${ordinal}`),
        type: "turn-item.updated",
        threadId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:memory-watermark:${ordinal}`),
          threadId,
          runId: itemRunId,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: `command ${ordinal}`,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: `echo ${ordinal}`,
          output: "ok",
          exitCode: 0,
        },
      });
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      yield* applyItem(ordinal, null);
    }
    yield* projectionStore.apply({
      id: EventId.make("event:memory-watermark:run-rolled-back"),
      type: "run.updated",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: { ...run, status: "rolled_back" as const, completedAt: now },
    });
    // The newest stored row belongs to the rolled-back run: it is filtered out
    // of visible eligibility but must still land in turnItems so
    // latestLocalTurnOrdinal matches the SQL path's latest-row watermark.
    yield* applyItem(4, runId);

    const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 2,
    });
    assert.deepEqual(
      windowed.projection.visibleTurnItems.map((row) => row.item.ordinal),
      [2, 3],
    );
    assert.isTrue(windowed.hasOlderHistory);
    assert.isTrue(windowed.projection.turnItems.some((item) => item.ordinal === 4));
    const bounded = buildBoundedThreadProjection({
      projection: windowed.projection,
      snapshotSequence: windowed.snapshotSequence,
      hasOlderHistory: windowed.hasOlderHistory,
    });
    assert.strictEqual(bounded.latestLocalTurnOrdinal, 4);
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory snapshot windows filter collections to the retained cohort", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:memory-cohort");
    yield* projectionStore.apply({
      id: EventId.make("event:memory-cohort:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:memory-cohort"),
        title: "memory cohort window",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
    for (const suffix of ["a", "b"] as const) {
      const runId = RunId.make(`run:memory-cohort:${suffix}`);
      const rootNodeId = NodeId.make(`node:memory-cohort:${suffix}:root`);
      const messageId = MessageId.make(`message:memory-cohort:${suffix}`);
      yield* projectionStore.apply({
        id: EventId.make(`event:memory-cohort:${suffix}:run`),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: suffix === "a" ? 1 : 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: messageId,
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make(`event:memory-cohort:${suffix}:message`),
        type: "message.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: messageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "assistant",
          text: `answer ${suffix}`,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make(`event:memory-cohort:${suffix}:node:root`),
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
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      for (let index = 0; index < 5; index += 1) {
        const nodeId = NodeId.make(`node:memory-cohort:${suffix}:${index}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:memory-cohort:${suffix}:node:${index}`),
          type: "node.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: rootNodeId,
            rootNodeId,
            kind: "tool_call",
            status: "completed",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: now,
          },
        });
        const ordinal = (suffix === "a" ? 0 : 5) + index + 1;
        yield* projectionStore.apply({
          id: EventId.make(`event:memory-cohort:${suffix}:item:${index}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:memory-cohort:${suffix}:${index}`),
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: `command ${suffix}:${index}`,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            ...(index === 0
              ? {
                  type: "assistant_message",
                  messageId,
                  text: `answer ${suffix}`,
                  attachments: [],
                  streaming: false,
                }
              : {
                  type: "command_execution",
                  input: `echo ${suffix}:${index}`,
                  output: "ok",
                  exitCode: 0,
                }),
          },
        });
      }
    }

    const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 5,
    });
    assert.lengthOf(windowed.projection.visibleTurnItems, 5);
    assert.isTrue(windowed.hasOlderHistory);
    // The retained window is run b's five items: only run b, its nodes (plus
    // the root ancestor), and the message its items reference may hydrate —
    // run a's history stays in storage but not in this response.
    assert.deepEqual(
      windowed.projection.runs.map((run) => String(run.id)),
      ["run:memory-cohort:b"],
    );
    const nodeIds = new Set(windowed.projection.nodes.map((node) => String(node.id)));
    assert.isTrue(nodeIds.has("node:memory-cohort:b:root"));
    assert.isTrue(nodeIds.has("node:memory-cohort:b:4"));
    assert.isFalse([...nodeIds].some((id) => id.startsWith("node:memory-cohort:a")));
    assert.deepEqual(
      windowed.projection.messages.map((message) => String(message.id)),
      ["message:memory-cohort:b"],
    );

    const full = yield* projectionStore.getThreadProjection(threadId);
    assert.lengthOf(full.runs, 2);
    assert.lengthOf(full.messages, 2);
    assert.isTrue(full.nodes.some((node) => String(node.id).startsWith("node:memory-cohort:a")));
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory snapshot windows retain sessions behind foreign-owned provider threads", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    // Projection insertion order must not decide which provider-thread copy the
    // global view keeps: run the fixture with the owning thread created both
    // after and before the reading thread.
    for (const order of ["ab", "ba"] as const) {
      const threadId = ThreadId.make(`thread:memory-shared-session:${order}:a`);
      const otherThreadId = ThreadId.make(`thread:memory-shared-session:${order}:b`);
      const created = order === "ab" ? [threadId, otherThreadId] : [otherThreadId, threadId];
      for (const id of created) {
        yield* projectionStore.apply({
          id: EventId.make(`event:memory-shared-session:${id}:thread`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id,
            projectId: ProjectId.make(`project:memory-shared-session:${id}`),
            title: "memory shared session",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: id,
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
      }
      const sessionId = ProviderSessionId.make(`provider-session:memory-shared-session:${order}`);
      yield* projectionStore.apply({
        id: EventId.make(`event:memory-shared-session:${order}:session`),
        type: "provider-session.attached",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      const providerThreadId = ProviderThreadId.make(
        `provider-thread:memory-shared-session:${order}`,
      );
      // The retained item points at a provider thread owned by another app
      // thread: SQL joins provider_threads globally, so the session behind it
      // must still hydrate into this thread's windowed snapshot.
      yield* projectionStore.apply({
        id: EventId.make(`event:memory-shared-session:${order}:provider-thread`),
        type: "provider-thread.updated",
        threadId: otherThreadId,
        driver,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: sessionId,
          appThreadId: otherThreadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make(`event:memory-shared-session:${order}:item`),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:memory-shared-session:${order}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "echo hi",
          output: "hi",
          exitCode: 0,
        },
      });

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 5,
      });
      assert.deepEqual(
        windowed.projection.providerThreads.map((thread) => String(thread.id)),
        [String(providerThreadId)],
      );
      assert.deepEqual(
        windowed.projection.providerSessions.map((session) => String(session.id)),
        [String(sessionId)],
      );

      // A provider-thread event routed through this thread stream replaces the
      // global row (ON CONFLICT(provider_thread_id) in SQL): the windowed read
      // must serve the latest version, not the stale copy left in the other
      // thread's projection.
      yield* projectionStore.apply({
        id: EventId.make(`event:memory-shared-session:${order}:provider-thread-update`),
        type: "provider-thread.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: otherThreadId,
          ownerNodeId: null,
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
      const updated = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 5,
      });
      assert.strictEqual(updated.projection.providerThreads[0]?.status, "active");
      assert.lengthOf(updated.projection.providerSessions, 0);
    }
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory snapshot windows keep compacted items schema-valid", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:memory-schema-safe");
    yield* projectionStore.apply({
      id: EventId.make("event:memory-schema-safe:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:memory-schema-safe"),
        title: "Schema-safe memory bounds",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
    // A large terminal context record inside a large message pushes the item
    // over the row cap. Compaction drops the record's required `text`, which
    // is only safe because the result decodes back through the schema — the
    // forward-compatible records array drops the malformed record. Compacting
    // the decoded object directly would return a corrupt item instead.
    yield* projectionStore.apply({
      id: EventId.make("event:memory-schema-safe:item"),
      type: "turn-item.updated",
      threadId,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:memory-schema-safe:1"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("message:memory-schema-safe"),
        inputIntent: "turn_start",
        text: "m".repeat(70_000),
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("ctx-memory-schema-safe"),
              label: "terminal",
              kind: "terminal",
              terminalId: "term-1",
              terminalLabel: "term",
              lineStart: 0,
              lineEnd: 10,
              text: "x".repeat(64_000),
            },
          ],
        },
        attachments: [],
      },
    });
    // Deep-but-small: under the byte cap but past the depth cap. The SQL path
    // serves a depth-collapsed preview; memory must emit the same bounded
    // shape rather than leaking the full 1,100-level structure.
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let index = 0; index < 1100; index += 1) deep = { next: deep };
    yield* projectionStore.apply({
      id: EventId.make("event:memory-schema-safe:item-deep"),
      type: "turn-item.updated",
      threadId,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:memory-schema-safe:2"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("message:memory-schema-safe:2"),
        inputIntent: "turn_start",
        text: "shallow text, deep context",
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("ctx-memory-schema-safe-deep"),
              label: "deep",
              kind: "custom-deep",
              payload: deep,
            },
          ],
        },
        attachments: [],
      },
    });

    const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 75,
    });
    const encode = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
    const items = [
      ...windowed.projection.turnItems,
      ...windowed.projection.visibleTurnItems.map((row) => row.item),
    ];
    assert.isAbove(items.length, 0);
    for (const item of items) {
      yield* encode(item);
    }
    const measureDepth = (value: unknown): number =>
      typeof value === "object" && value !== null
        ? 1 + Math.max(0, ...Object.values(value).map(measureDepth))
        : 0;
    const deepItem = windowed.projection.turnItems.find(
      (item) => item.id === TurnItemId.make("item:memory-schema-safe:2"),
    );
    const deepRecord = deepItem?.type === "user_message" ? deepItem.context?.records[0] : undefined;
    assert.strictEqual(deepRecord?.kind, "custom-deep");
    if (deepRecord !== undefined && "payload" in deepRecord) {
      assert.isAtMost(measureDepth(deepRecord.payload), 600);
    }

    const full = yield* projectionStore.getThreadProjection(threadId);
    const fullItem = full.turnItems[0];
    assert.strictEqual(fullItem?.type, "user_message");
    const record = fullItem?.type === "user_message" ? fullItem.context?.records[0] : undefined;
    assert.strictEqual(record?.kind, "terminal");
    if (record !== undefined && "text" in record) {
      assert.strictEqual(record.text.length, 64_000);
    }
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory snapshot windows bound payloads deeper than the serializer stack", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:memory-deep-stack");
    yield* projectionStore.apply({
      id: EventId.make("event:memory-deep-stack:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:memory-deep-stack"),
        title: "Deep stack memory bounds",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
    // An Unknown member passes through schema encode untouched, so a value
    // nested past the JSON.stringify recursion limit reaches bounding whole —
    // billing and encode must walk it with an explicit stack, not recurse.
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let index = 0; index < 7_000; index += 1) deep = { next: deep };
    yield* projectionStore.apply({
      id: EventId.make("event:memory-deep-stack:item"),
      type: "turn-item.updated",
      threadId,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:memory-deep-stack:1"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool",
        toolName: "deep_tool",
        input: deep,
      },
    });

    const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 75,
    });
    assert.strictEqual(windowed.projection.visibleTurnItems.length, 1);
    const item = windowed.projection.visibleTurnItems[0]!.item;
    assert.strictEqual(item.type, "dynamic_tool");
    // Iterative: a recursive depth check would overflow on the unbounded input.
    const chainDepth = (value: unknown): number => {
      let depth = 0;
      let node = value;
      while (typeof node === "object" && node !== null && "next" in node) {
        node = (node as { readonly next: unknown }).next;
        depth += 1;
      }
      return depth;
    };
    if (item.type === "dynamic_tool") {
      assert.isAtMost(chainDepth(item.input), 600);
    }

    const full = yield* projectionStore.getThreadProjection(threadId);
    const fullItem = full.turnItems[0];
    assert.strictEqual(fullItem?.type, "dynamic_tool");
    if (fullItem?.type === "dynamic_tool") {
      assert.isAbove(chainDepth(fullItem.input), 6_000);
    }
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory billing measures deep over-cap rows without recursing the serializer", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:memory-deep-billing");
    yield* projectionStore.apply({
      id: EventId.make("event:memory-deep-billing:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:memory-deep-billing"),
        title: "Deep billing",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
    // ~72 KB of nesting crosses the row byte cap, so window billing must
    // measure the emitted compaction — doing that on the decoded item feeds
    // 8,000-deep subtrees to JSON.stringify and overflows the stack. The
    // emitted-size bill has to go through the encode → stringifyJsonDeep →
    // depth-splice pipeline that boundRow already uses.
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let index = 0; index < 8_000; index += 1) deep = { next: deep };
    yield* projectionStore.apply({
      id: EventId.make("event:memory-deep-billing:item"),
      type: "turn-item.updated",
      threadId,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:memory-deep-billing:1"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool",
        toolName: "deep_tool",
        input: deep,
      },
    });

    const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 75,
    });
    assert.strictEqual(windowed.projection.visibleTurnItems.length, 1);
    const item = windowed.projection.visibleTurnItems[0]!.item;
    assert.strictEqual(item.type, "dynamic_tool");
    if (item.type === "dynamic_tool") {
      let depth = 0;
      let node: unknown = item.input;
      while (typeof node === "object" && node !== null && "next" in node) {
        node = (node as { readonly next: unknown }).next;
        depth += 1;
      }
      assert.isAtMost(depth, 600);
    }
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory windows bill the item payload like SQL, not the projected row", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:memory-row-billing");
    yield* projectionStore.apply({
      id: EventId.make("event:memory-row-billing:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:memory-row-billing"),
        title: "Row billing parity",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
    // Each item's payload is ~900 bytes: two payloads fit the 1.9 KB window
    // budget, while billing the projected wrapper (visibility/source ids/
    // position envelope around the item) would push the pair over it.
    for (const ordinal of [1, 2]) {
      yield* projectionStore.apply({
        id: EventId.make(`event:memory-row-billing:item-${ordinal}`),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:memory-row-billing:${ordinal}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "cmd",
          output: "x".repeat(500),
          exitCode: 0,
        },
      });
    }

    const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 75,
      maxWindowBytes: 1_900,
    });
    assert.strictEqual(windowed.projection.visibleTurnItems.length, 2);
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.effect("memory snapshot windows surface missing threads as not-found, not read errors", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    // The window's mapError wraps only the decode/bounding gen inside the
    // flatMap; the snapshot lookup's not-found failure must reach callers
    // untagged as a read error so isThreadNotFound still maps it.
    const error = yield* projectionStore
      .getThreadSnapshotWindow(ThreadId.make("thread:missing-window"), { rowLimit: 75 })
      .pipe(Effect.flip);
    assert.instanceOf(error, ProjectionStoreThreadNotFoundError);
  }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it("bounds write-time previews for free-form record members", () => {
  const payload = {
    id: "item:preview-record-members",
    threadId: "thread:preview-record-members",
    type: "user_input_request",
    questionAnswer: {
      requestId: "request:preview-record-members",
      questionTextById: { ["k".repeat(100_000)]: "x" },
      answers: { ["a".repeat(100_000)]: "v" },
      attachmentsByQuestionId: { ["b".repeat(100_000)]: [] },
    },
    context: {
      version: 1,
      records: [{ ["c".repeat(100_000)]: "d" }],
    },
  };
  const previewJson = boundedPayloadPreviewJson(JSON.stringify(payload));
  assert.isNotNull(previewJson);
  assert.isAtMost(Buffer.byteLength(previewJson!, "utf8"), THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES);
});

it("keeps discriminators and identifiers intact when the member budget bottoms out", () => {
  // A schema-valid payload heavy enough to push the iterated member budget
  // below every short string: discriminators, ids, and timestamps must survive
  // untouched or the preview fails schema decode entirely.
  const payload = {
    id: "item:preview-floor",
    threadId: "thread:preview-floor",
    runId: "run:preview-floor",
    nodeId: "node:preview-floor",
    type: "assistant_message",
    createdAt: "2026-09-13T12:00:00.000Z",
    text: "a".repeat(200_000),
    context: {
      version: 1,
      records: Array.from({ length: 64 }, (_, index) => ({
        key: `record:${index}`,
        value: "x".repeat(4_000),
      })),
    },
  };
  const previewJson = boundedPayloadPreviewJson(JSON.stringify(payload));
  assert.isNotNull(previewJson);
  const preview = JSON.parse(previewJson!) as Record<string, unknown>;
  assert.strictEqual(preview.type, "assistant_message");
  assert.strictEqual(preview.id, "item:preview-floor");
  assert.strictEqual(preview.threadId, "thread:preview-floor");
  assert.strictEqual(preview.createdAt, "2026-09-13T12:00:00.000Z");
});

it("bounds self-similar typed chains like nested accessibility nodes", () => {
  // A schema-valid deep tree whose fixed-key skeleton alone exceeds the row
  // cap: only dropping array members entirely brings it under — keeping a
  // first element unconditionally would preserve the whole chain.
  type Node = { role: string; children: Node[] };
  let node: Node = { role: "界".repeat(100), children: [] };
  for (let index = 0; index < 229; index += 1) {
    node = { role: "界".repeat(100), children: [node] };
  }
  const payload = {
    id: "item:preview-deep-tree",
    threadId: "thread:preview-deep-tree",
    type: "tool_call",
    tool: "desktop_snapshot",
    output: { accessibility: { root: node } },
  };
  const previewJson = boundedPayloadPreviewJson(JSON.stringify(payload));
  assert.isNotNull(previewJson);
  assert.isAtMost(Buffer.byteLength(previewJson!, "utf8"), THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES);
  const preview = JSON.parse(previewJson!) as { type: string; id: string };
  assert.strictEqual(preview.type, "tool_call");
  assert.strictEqual(preview.id, "item:preview-deep-tree");
});

it("keeps required typed members on nodes retained at the depth cap", () => {
  // A typed recursive structure nests ~2 levels per node, so a 300-node chain
  // puts node members past the soft depth cap. Typed objects keep every key
  // there — stubbing them to {} would break schema decode — while their
  // children arrays still collapse to bound the chain.
  type Node = { role: string; bounds: { x: number; y: number }; children: Node[] };
  let node: Node = { role: "root", bounds: { x: 0, y: 0 }, children: [] };
  for (let index = 0; index < 300; index += 1) {
    node = { role: `role-${index}`, bounds: { x: index, y: index }, children: [node] };
  }
  const payload = {
    id: "item:preview-depth-typed",
    threadId: "thread:preview-depth-typed",
    type: "tool_call",
    tool: "desktop_snapshot",
    output: { accessibility: { root: node } },
  };
  const previewJson = boundedPayloadPreviewJson(JSON.stringify(payload));
  assert.isNotNull(previewJson);
  const preview = JSON.parse(previewJson!) as {
    output: {
      accessibility: { root: { role: string; bounds: { x: number }; children: unknown[] } };
    };
  };
  let cursor = preview.output.accessibility.root;
  let depth = 0;
  while (cursor.children.length > 0) {
    cursor = cursor.children[0] as typeof cursor;
    depth += 1;
    // Every retained node keeps its required members — no {} stubs.
    assert.strictEqual(typeof cursor.role, "string");
    assert.strictEqual(typeof cursor.bounds.x, "number");
  }
  assert.isAbove(depth, 100);
});

it("bounds preview depth so SQLite JSON1 can still parse it", () => {
  // Bounded reads run json_extract on stored previews, and JSON1 rejects
  // documents nested past ~1000 levels — a byte-small payload can still be
  // unreadably deep, so depth alone must force a preview and cap the result.
  let deep: Record<string, unknown> = { leaf: "x" };
  for (let index = 0; index < 1100; index += 1) deep = { next: deep };
  const payload = {
    id: "item:preview-depth",
    threadId: "thread:preview-depth",
    type: "user_message",
    text: "hello",
    context: { version: 1, records: [{ payload: deep }] },
  };
  const previewJson = boundedPayloadPreviewJson(JSON.stringify(payload));
  assert.isNotNull(previewJson);
  const measureDepth = (value: unknown): number =>
    typeof value === "object" && value !== null
      ? 1 + Math.max(0, ...Object.values(value).map(measureDepth))
      : 0;
  assert.isAtMost(measureDepth(JSON.parse(previewJson!)), 300);
});

it("produces a preview for payloads deeper than the JS serializer stack", () => {
  // Payloads nested thousands of levels deep can be stored by runtimes whose
  // JSON.stringify tolerates them, but the same depth overflows the parser or
  // serializer elsewhere — so preview generation splices over-deep subtrees
  // out of the raw text before JSON.parse ever runs. Built textually because
  // this runtime's own JSON.stringify cannot construct it.
  const deep = `${"[".repeat(7000)}1${"]".repeat(7000)}`;
  const payloadJson = `{"id":"item:preview-stack-depth","threadId":"thread:preview-stack-depth","type":"user_message","deep":${deep}}`;
  const previewJson = boundedPayloadPreviewJson(payloadJson);
  assert.isNotNull(previewJson);
  assert.isFalse(jsonDepthExceeds(previewJson!, THREAD_HISTORY_PREVIEW_HARD_DEPTH));
  const preview = JSON.parse(previewJson!) as { id: string; type: string };
  assert.strictEqual(preview.id, "item:preview-stack-depth");
  assert.strictEqual(preview.type, "user_message");
});

it("never truncates identity members that cursors and cohort joins compare", () => {
  // A 300+ character id is a legal TurnItemId; truncating it to the string
  // floor still decodes but the cursor si no longer matches the stored
  // turn_item_id column, so the next anchored page comes back empty and
  // strands all older history.
  const longId = `item:preview-identity:${"i".repeat(300)}`;
  const payload = {
    id: longId,
    sourceItemId: `src:${"s".repeat(300)}`,
    threadId: `thread:preview-identity:${"t".repeat(200)}`,
    nativeItemRef: `ref:${"r".repeat(280)}`,
    type: "assistant_message",
    text: "display text ".repeat(40_000),
  };
  const previewJson = boundedPayloadPreviewJson(JSON.stringify(payload));
  assert.isNotNull(previewJson);
  const preview = JSON.parse(previewJson!) as Record<string, string>;
  assert.strictEqual(preview.id, longId);
  assert.strictEqual(preview.sourceItemId, payload.sourceItemId);
  assert.strictEqual(preview.threadId, payload.threadId);
  assert.strictEqual(preview.nativeItemRef, payload.nativeItemRef);
  // Display text still compacts — the cap yields only for identity members.
  assert.isBelow(preview.text!.length, payload.text.length);
});

it.effect(
  "memory snapshot windows retain a pending request's display item as a hidden dependency",
  () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:memory-pending-dep");
      yield* projectionStore.apply({
        id: EventId.make("event:memory-pending-dep:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:memory-pending-dep"),
          title: "memory pending dep",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
      const itemBase = {
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:memory-pending-dep:question"),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          ...itemBase,
          id: TurnItemId.make("item:memory-pending-dep:question"),
          ordinal: 1,
          status: "pending",
          completedAt: null,
          type: "user_input_request",
          requestId: RuntimeRequestId.make("request:memory-pending-dep"),
          questions: [
            {
              header: "Pick",
              id: "q1",
              options: [
                { label: "a", description: "first" },
                { label: "b", description: "second" },
              ],
              question: "which?",
            },
          ],
        },
      });
      for (let index = 2; index <= 80; index += 1) {
        yield* projectionStore.apply({
          id: EventId.make(`event:memory-pending-dep:${index}`),
          type: "turn-item.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            ...itemBase,
            id: TurnItemId.make(`item:memory-pending-dep:${index}`),
            ordinal: index,
            type: "command_execution",
            input: "cmd",
            output: "ok",
            exitCode: 0,
          },
        });
      }
      yield* projectionStore.apply({
        id: EventId.make("event:memory-pending-dep:request"),
        type: "runtime-request.updated",
        threadId,
        runId: undefined,
        nodeId: NodeId.make("node:memory-pending-dep"),
        driver,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("request:memory-pending-dep"),
          nodeId: NodeId.make("node:memory-pending-dep"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      assert.isTrue(
        windowed.projection.runtimeRequests.some(
          (request) => request.id === RuntimeRequestId.make("request:memory-pending-dep"),
        ),
      );
      assert.isTrue(
        windowed.projection.turnItems.some(
          (item) => item.id === TurnItemId.make("item:memory-pending-dep:question"),
        ),
      );
      assert.isFalse(
        windowed.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === TurnItemId.make("item:memory-pending-dep:question"),
        ),
      );
    }).pipe(Effect.provide(projectionStoreMemoryLayer)),
);

it.layer(TestLayer)("ProjectionStoreV2", (it) => {
  it.effect("limits turn-start history to the requested runs, including an empty selection", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("selected-turn-start-history");
      const runId = (yield* store.getThreadProjection(threadId)).runs[0]!.id;
      const history = yield* store.getTurnStartHistory(threadId);
      assert.isNotEmpty(history);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [runId]), history);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, []), []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [RunId.make("run:other")]), []);
    }),
  );

  it.effect("surfaces missing threads as not-found, not read errors", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const error = yield* projectionStore
        .getThreadSnapshotWindow(ThreadId.make("thread:missing-window"), { rowLimit: 75 })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProjectionStoreThreadNotFoundError);
    }),
  );

  it.effect("preserves stored provider usage when a terminal update omits it", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-usage-reload");
      const providerThreadId = ProviderThreadId.make("provider-thread:provider-usage-reload");
      const providerTurnId = ProviderTurnId.make("provider-turn:provider-usage-reload");
      const nodeId = NodeId.make("node:provider-usage-reload");
      const initialUsage = {
        usedTokens: 12_000,
        maxTokens: 200_000,
        inputTokens: 11_000,
        outputTokens: 1_000,
        updatedAt: "2026-08-29T12:00:00.000Z",
      } as const;
      const replacementUsage = {
        usedTokens: 18_000,
        maxTokens: 200_000,
        inputTokens: 16_000,
        outputTokens: 2_000,
        updatedAt: "2026-08-29T12:00:01.000Z",
      } as const;

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-usage-reload"),
          title: "Provider usage reload",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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

      const providerTurn = {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:running"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, tokenUsage: initialUsage },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:completed"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, status: "completed", completedAt: now },
      });

      const reloaded = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(reloaded.providerTurns[0]?.tokenUsage, initialUsage);
      assert.strictEqual(reloaded.providerTurns[0]?.status, "completed");

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:replacement"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          ...providerTurn,
          status: "completed",
          completedAt: now,
          tokenUsage: replacementUsage,
        },
      });

      const replaced = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(replaced.providerTurns[0]?.tokenUsage, replacementUsage);
    }),
  );

  it.effect("pages complete user turns through SQL regardless of tool count or payload size", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:user-turn-pages");
      yield* projectionStore.apply({
        id: EventId.make("event:user-turn-pages:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:user-turn-pages"),
          title: "Bounded SQL history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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

      const allIds: string[] = [];
      let lastToolPayload = "";
      // 64 items per turn keeps a 20-turn page inside the hard SQL row and
      // payload-byte caps while still exercising many tools and large outputs.
      const itemsPerTurn = 64;
      for (let turn = 1; turn <= 45; turn += 1) {
        const rows = Array.from({ length: itemsPerTurn }, (_, offset) => {
          const ordinal = (turn - 1) * itemsPerTurn + offset + 1;
          const id = `item:user-turn-pages:${ordinal}`;
          allIds.push(id);
          const base = {
            id,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
          };
          const item =
            offset < 2
              ? {
                  ...base,
                  type: "user_message",
                  createdBy: "user",
                  creationSource: "web",
                  messageId: `message:${id}`,
                  inputIntent: offset === 0 ? "turn_start" : "steer",
                  text: `Turn ${turn}`,
                  attachments: [],
                }
              : {
                  ...base,
                  type: "command_execution",
                  input: "command",
                  output: "x".repeat(2048),
                  exitCode: 0,
                };
          const payloadJson = encodeUnknownJsonString(item);
          if (offset >= 2) lastToolPayload = payloadJson;
          return {
            turn_item_id: id,
            thread_id: threadId,
            run_id: null,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: item.type,
            status: "completed",
            updated_at: nowIso,
            payload_json: payloadJson,
          };
        });
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
      }
      const initial = yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(JSON, "parse")),
        (parse) =>
          projectionStore
            .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 10 })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  // Tool outputs must not be allocated again just to collect cohort IDs.
                  assert.lengthOf(
                    parse.mock.calls.filter(([input]) => input === lastToolPayload),
                    1,
                  );
                }),
              ),
            ),
        (parse) => Effect.sync(() => parse.mockRestore()),
      );
      // Only the selected turn cohort and two lookahead anchors are decoded.
      assert.lengthOf(initial.projection.turnItems, 12 * itemsPerTurn);
      const bounded = buildBoundedThreadProjection({
        projection: initial.projection,
        snapshotSequence: 0,
      });
      assert.lengthOf(bounded.projection.visibleTurnItems, 10 * itemsPerTurn);
      assert.strictEqual(
        bounded.projection.visibleTurnItems[0]?.sourceItemId,
        allIds[35 * itemsPerTurn],
      );
      const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      let cursor = bounded.historyCursor;
      for (const turns of [20, 15]) {
        assert.isNotNull(cursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          ...anchorWindowOptions(cursor!),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor: cursor!,
          snapshotSequence: 0,
        });
        assert.lengthOf(page.items, turns * itemsPerTurn);
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
      }
      assert.isNull(cursor);
      assert.deepEqual(loaded, allIds);
    }),
  );

  it.effect("pages v2 history past equal-ordinal siblings without skipping rows", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const { threadId, allIds } = yield* seedDuplicateOrdinalThread("dup-ordinal-window");

      // Five rows puts the window edge on the index-5 item — the sibling that
      // sorts second at ordinal 5 — so its page must not drop the index-4 item.
      const initial = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 5,
      });
      const bounded = buildBoundedThreadProjection({
        projection: initial.projection,
        snapshotSequence: 0,
        hasOlderHistory: initial.hasOlderHistory,
      });
      const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      let cursor = bounded.historyCursor;
      while (cursor !== null) {
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 2,
          ...anchorWindowOptions(cursor),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: 0,
          hasOlderHistory: snapshot.hasOlderHistory,
        });
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.hasMoreHistory ? page.nextCursor : null;
      }
      assert.deepEqual(loaded, allIds);
    }),
  );

  it.effect("pages v1 history past equal-ordinal siblings without skipping rows", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const { threadId, allIds } = yield* seedDuplicateOrdinalThread("dup-ordinal-v1");

      // v1 cursors carry verbatim ids but no ordinal, so the same-ordinal
      // progress branch must resolve the anchor's ordinal by id before the
      // sibling comparison applies. Anchoring on the index-5 item (the sibling
      // that sorts second at ordinal 5) must surface the index-4 item before
      // lower ordinals.
      const v1Cursor = Buffer.from(
        encodeUnknownJsonString({ v: 1, seq: 0, st: threadId, si: allIds[5], p: 0 }),
        "utf8",
      ).toString("base64url");
      const loaded: Array<string> = [];
      let cursor: string | null = v1Cursor;
      while (cursor !== null) {
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 1,
          ...anchorWindowOptions(cursor),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: 0,
          hasOlderHistory: snapshot.hasOlderHistory,
        });
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.hasMoreHistory ? page.nextCursor : null;
      }
      assert.deepEqual(loaded, allIds.slice(0, 5));
    }),
  );

  it.effect("resolves v2 anchors for item ids carrying lone surrogates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:surrogate-anchor");
      yield* projectionStore.apply({
        id: EventId.make("event:surrogate-anchor:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:surrogate-anchor"),
          title: "Surrogate anchor",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
      // The driver's UTF-8 binding folds the lone surrogate to U+FFFD in the
      // turn_item_id column while payload JSON preserves the raw code unit.
      // Cursors hash the decoded id, so anchor resolution must hash the
      // decoded id rather than the column value.
      const surrogateId = "item:surrogate-anchor:3:" + String.fromCharCode(0xd800);
      const seeded = [
        { id: "item:surrogate-anchor:1", ordinal: 1 },
        { id: "item:surrogate-anchor:2", ordinal: 2 },
        { id: surrogateId, ordinal: 3 },
        { id: "item:surrogate-anchor:3z", ordinal: 3 },
      ];
      const rows = seeded.map(({ id, ordinal }) => {
        const item = {
          type: "command_execution",
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          input: `cmd-${ordinal}`,
          output: "ok",
          exitCode: 0,
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
        };
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: null,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: item.type,
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString(item),
        };
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;

      const cursor = encodeThreadHistoryCursor({
        snapshotSequence: 0,
        sourceThreadId: threadId,
        sourceItemId: surrogateId,
        sourceItemOrdinal: 3,
        position: 0,
      });
      const loaded: Array<string> = [];
      let next: string | null = cursor;
      while (next !== null) {
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 1,
          ...anchorWindowOptions(next),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor: next,
          snapshotSequence: 0,
          hasOlderHistory: snapshot.hasOlderHistory,
        });
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        next = page.hasMoreHistory ? page.nextCursor : null;
      }
      // The mangled column id sorts before the "…3z" sibling, so the surrogate
      // row is the older sibling: everything strictly below the anchor must
      // page in.
      assert.deepEqual(loaded, ["item:surrogate-anchor:1", "item:surrogate-anchor:2"]);
      yield* purgeProjectionRows([threadId]);
    }),
  );

  it.effect("caps SQL rows for a single oversized turn and keeps dropped rows pageable", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:oversized-turn-window");
      yield* projectionStore.apply({
        id: EventId.make("event:oversized-turn-window:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:oversized-turn-window"),
          title: "Oversized turn window",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      const allIds: string[] = [];
      const rows = Array.from({ length: 40 }, (_, offset) => {
        const ordinal = offset + 1;
        const id = `item:oversized-turn-window:${ordinal}`;
        allIds.push(id);
        const base = {
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
        };
        const item =
          ordinal === 1
            ? {
                ...base,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                messageId: `message:${id}`,
                inputIntent: "turn_start",
                text: "One very long turn",
                attachments: [],
              }
            : {
                ...base,
                type: "command_execution",
                input: `command ${ordinal}`,
                output: "ok",
                exitCode: 0,
              };
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: null,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: item.type,
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString(item),
        };
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;

      // A single turn that exceeds the row cap is bounded in SQL rather than
      // materializing every row before decode.
      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 77,
        userTurnLimit: 10,
        maxWindowRows: 8,
      });
      assert.isTrue(windowed.hasOlderHistory);
      assert.isAtMost(windowed.projection.turnItems.length, 9);
      assert.strictEqual(windowed.projection.turnItems.at(-1)?.id, allIds.at(-1));

      const bounded = buildBoundedThreadProjection({
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      });
      assert.isTrue(bounded.hasMoreHistory);
      const cursor = bounded.historyCursor;
      assert.isNotNull(cursor);

      // The cursor anchors at the oldest kept row, so the next page covers
      // the rows the cap dropped inside the same turn.
      const pageSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 77,
        userTurnLimit: 20,
        ...anchorWindowOptions(cursor!),
      });
      const page = selectHistoryPageFromCursor({
        items: pageSnapshot.projection.visibleTurnItems,
        cursor: cursor!,
        snapshotSequence: pageSnapshot.snapshotSequence,
        hasOlderHistory: pageSnapshot.hasOlderHistory,
      });
      const loaded = [
        ...page.items.map((row) => String(row.sourceItemId)),
        ...bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
      ];
      assert.deepEqual(loaded.toSorted(), allIds.toSorted());
    }),
  );

  it.effect("compacts oversized payloads and keeps them inside the window", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:huge-payload-window");
      yield* projectionStore.apply({
        id: EventId.make("event:huge-payload-window:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:huge-payload-window"),
          title: "Huge payload window",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      const hugeOutput = "x".repeat(200_000);
      const rows = [
        {
          id: "item:huge-payload-window:1",
          type: "user_message",
          extra: {
            createdBy: "user",
            creationSource: "web",
            messageId: "message:huge-payload-window:1",
            inputIntent: "turn_start",
            text: "run something loud",
            attachments: [],
          },
        },
        {
          id: "item:huge-payload-window:2",
          type: "command_execution",
          extra: {
            input: "yes | head",
            output: hugeOutput,
            exitCode: 0,
          },
        },
      ].map(({ id, type, extra }, index) => ({
        turn_item_id: id,
        thread_id: threadId,
        run_id: null,
        node_id: null,
        provider_thread_id: null,
        provider_turn_id: null,
        parent_item_id: null,
        ordinal: index + 1,
        type,
        status: "completed",
        updated_at: nowIso,
        payload_json: encodeUnknownJsonString({
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index + 1,
          status: "completed",
          title: null,
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
          type,
          ...extra,
        }),
      }));
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 77,
        userTurnLimit: 10,
        maxRowPayloadBytes: 4_096,
      });
      assert.isFalse(windowed.hasOlderHistory);
      const commandItem = windowed.projection.turnItems.find(
        (item) => item.type === "command_execution",
      );
      assert.isDefined(commandItem);
      // The oversized field is capped before schema decode — directly seeded
      // rows have no write-time preview, so the read-side pass bounds them.
      if (commandItem?.type === "command_execution") {
        assert.isAtMost(commandItem.output?.length ?? 0, THREAD_HISTORY_COMPACTED_FIELD_CHARS);
      }
    }),
  );

  it.effect("does not report older history for rows the progress branch already kept", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      for (const [suffix, itemCount] of [
        ["single", 1],
        ["pair", 2],
      ] as const) {
        const threadId = ThreadId.make(`thread:forced-kept:${suffix}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:forced-kept:${suffix}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make(`project:forced-kept:${suffix}`),
            title: `forced kept ${suffix}`,
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
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
        const rows = Array.from({ length: itemCount }, (_, index) => {
          const id = `item:forced-kept:${suffix}:${index + 1}`;
          return {
            turn_item_id: id,
            thread_id: threadId,
            run_id: null,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal: index + 1,
            type: "command_execution",
            status: "completed",
            updated_at: nowIso,
            payload_json: encodeUnknownJsonString({
              id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: index + 1,
              status: "completed",
              title: null,
              input: "echo",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            }),
          };
        });
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;

        // A 1-byte window admits nothing through the caps; the progress branch
        // still force-keeps the newest eligible row. has_older must compare
        // eligible rows against every in-window row — a single kept row means
        // no older history, not a cursor that pages onto nothing.
        const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 10,
          maxWindowBytes: 1,
        });
        assert.lengthOf(windowed.projection.visibleTurnItems, 1);
        assert.strictEqual(
          windowed.projection.visibleTurnItems[0]?.item.id,
          `item:forced-kept:${suffix}:${itemCount}`,
        );
        assert.strictEqual(windowed.hasOlderHistory, itemCount > 1);
      }
    }),
  );

  const runWatermarkRollbackCase = Effect.fn("runWatermarkRollbackCase")(function* (
    suffix: string,
    runId: string,
  ) {
    const projectionStore = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const threadId = ThreadId.make(`thread:has-older-watermark:${suffix}`);
    yield* projectionStore.apply({
      id: EventId.make(`event:has-older-watermark:${suffix}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:has-older-watermark:${suffix}`),
        title: "watermark has_older",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
    yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${runId}, ${threadId}, 1, 'codex', NULL, 'rolled_back', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:has-older-watermark",
            rootNodeId: "node:has-older-watermark",
            activeAttemptId: null,
            status: "rolled_back",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
    const insertItem = (ordinal: number, itemRunId: string | null) => {
      const id = `item:has-older-watermark:${suffix}:${ordinal}`;
      return sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${itemRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: itemRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `command ${ordinal}`,
              input: `echo ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
    };
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      yield* insertItem(ordinal, null);
    }
    // The newest stored row belongs to the rolled-back run: eligible excludes
    // it, but the latest-row watermark union still lands it in kept — a
    // count comparison reports 3 = 3 and item 1 becomes unreachable.
    yield* insertItem(4, runId);

    const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 2,
    });
    // The watermark row stays out of the visible timeline but occupies kept.
    assert.deepEqual(
      windowed.projection.visibleTurnItems.map((row) => row.item.ordinal),
      [2, 3],
    );
    assert.isTrue(windowed.hasOlderHistory);

    const bounded = buildBoundedThreadProjection({
      projection: windowed.projection,
      snapshotSequence: windowed.snapshotSequence,
      hasOlderHistory: windowed.hasOlderHistory,
    });
    assert.isNotNull(bounded.historyCursor);
    const pageSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: 2,
      ...anchorWindowOptions(bounded.historyCursor!),
    });
    const page = selectHistoryPageFromCursor({
      items: pageSnapshot.projection.visibleTurnItems,
      cursor: bounded.historyCursor!,
      snapshotSequence: pageSnapshot.snapshotSequence,
      hasOlderHistory: pageSnapshot.hasOlderHistory,
    });
    assert.deepEqual(
      page.items.map((row) => row.item.ordinal),
      [1],
    );
    assert.isNull(page.nextCursor);
    yield* purgeProjectionRows([threadId]);
  });

  it.effect("reports older history when the watermark row is outside the eligible set", () =>
    runWatermarkRollbackCase("plain", "run:has-older-watermark:plain:rolled-back"),
  );

  it.effect("hides a rolled-back watermark row whose run id the driver mangled", () =>
    // The watermark union keeps the newest row for watermark fields even when
    // eligibility excluded it; hiding it used to depend on hydrating the run
    // through a bound-id json_each comparison, which misses when the driver's
    // text encoding altered the stored id. The row must stay out of the
    // visible timeline regardless.
    runWatermarkRollbackCase(
      "surrogate-run",
      "run:has-older-watermark:surrogate-run:rolled-back:" + String.fromCharCode(0xd800),
    ),
  );

  it.effect("stores a bounded preview at write time and keeps the raw payload", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:write-preview");
      yield* projectionStore.apply({
        id: EventId.make("event:write-preview:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:write-preview"),
          title: "Write-time preview",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      const hugeOutput = "y".repeat(200_000);
      yield* projectionStore.apply({
        id: EventId.make("event:write-preview:item"),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:write-preview:1"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "yes | head",
          output: hugeOutput,
          exitCode: 0,
        },
      });

      const rows = yield* sql<{
        readonly boundedJson: string | null;
        readonly payloadBytes: number;
      }>`
        SELECT bounded_json AS "boundedJson", LENGTH(CAST(payload_json AS BLOB)) AS "payloadBytes"
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:write-preview:1'
      `;
      const row = rows[0];
      assert.isDefined(row);
      // The complete payload is preserved; the preview stays under the row cap.
      assert.isAbove(row!.payloadBytes, 200_000);
      assert.isNotNull(row!.boundedJson);
      assert.isAtMost(
        Buffer.byteLength(row!.boundedJson!, "utf8"),
        THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES,
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const preview = JSON.parse(row!.boundedJson!) as { type: string; output: string };
      assert.strictEqual(preview.type, "command_execution");
      assert.isBelow(preview.output.length, hugeOutput.length);

      // A small payload keeps a NULL preview and is read raw.
      yield* projectionStore.apply({
        id: EventId.make("event:write-preview:item-small"),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:write-preview:2"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "echo ok",
          output: "ok",
          exitCode: 0,
        },
      });
      const smallRows = yield* sql<{ readonly boundedJson: string | null }>`
        SELECT bounded_json AS "boundedJson"
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:write-preview:2'
      `;
      assert.strictEqual(smallRows[0]?.boundedJson, null);
    }),
  );

  it.effect("reads bounded snapshots when a stored payload nests past JSON1's depth limit", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:deep-preview-read");
      yield* projectionStore.apply({
        id: EventId.make("event:deep-preview-read:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:deep-preview-read"),
          title: "Deep preview read",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      // ~1,100 nested members inside a Schema.Unknown context record payload:
      // byte-small but far past SQLite JSON1's nesting limit, so a preview that
      // only bounded bytes would still fail every json_extract on the bounded
      // read path with `malformed JSON`.
      let deep: Record<string, unknown> = { leaf: "x" };
      for (let index = 0; index < 1100; index += 1) deep = { next: deep };
      const deepContext = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            contextId: ComposerContextId.make("ctx-deep-preview-read"),
            label: "deep",
            kind: "custom-deep",
            payload: deep,
          },
        ],
      };
      yield* projectionStore.apply({
        id: EventId.make("event:deep-preview-read:item-large"),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:deep-preview-read:1"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message:deep-preview-read:1"),
          inputIntent: "turn_start",
          text: "t".repeat(70_000),
          context: deepContext,
          attachments: [],
        },
      });
      // A deep-but-small payload is over the depth cap alone — it must still
      // get a preview or every JSON1 extract on its raw payload fails.
      yield* projectionStore.apply({
        id: EventId.make("event:deep-preview-read:item-small"),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:deep-preview-read:2"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message:deep-preview-read:2"),
          inputIntent: "turn_start",
          text: "shallow text, deep context",
          context: deepContext,
          attachments: [],
        },
      });

      const stored = yield* sql<{ readonly boundedJson: string | null }>`
        SELECT bounded_json AS "boundedJson"
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:deep-preview-read:2'
      `;
      assert.isNotNull(stored[0]?.boundedJson);

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      assert.strictEqual(windowed.projection.visibleTurnItems.length, 2);

      const full = yield* projectionStore.getThreadProjection(threadId);
      const fullItem = full.turnItems[0];
      assert.strictEqual(fullItem?.type, "user_message");
      const fullRecord =
        fullItem?.type === "user_message" ? fullItem.context?.records[0] : undefined;
      assert.strictEqual(fullRecord?.kind, "custom-deep");
      const measureDepth = (value: unknown): number =>
        typeof value === "object" && value !== null
          ? 1 + Math.max(0, ...Object.values(value).map(measureDepth))
          : 0;
      if (fullRecord?.kind === "custom-deep") {
        assert.isAbove(measureDepth(fullRecord.payload), 1000);
      }
    }),
  );

  it.effect(
    "compacts structured array members without dropping required fields and bounds member count",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const threadId = ThreadId.make("thread:structured-compaction-window");
        yield* projectionStore.apply({
          id: EventId.make("event:structured-compaction-window:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:structured-compaction-window"),
            title: "Structured compaction window",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
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

        const insertTurnItem = (input: {
          id: string;
          ordinal: number;
          type: string;
          extra: Record<string, unknown>;
        }) => sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${input.id}, ${threadId}, NULL, NULL, NULL, NULL, NULL,
            ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id: input.id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: input.type,
              ...input.extra,
            })}
          )
        `;

        // A result object over the per-row cap must keep required fields like
        // fileName: earlier compaction replaced the whole element with {} and
        // the payload failed schema decode.
        yield* insertTurnItem({
          id: "item:structured-compaction-window:huge-result",
          ordinal: 1,
          type: "file_search",
          extra: {
            pattern: "needle",
            results: [
              {
                fileName: "src/needle.ts",
                line: 7,
                preview: "x".repeat(200_000),
              },
            ],
          },
        });
        // Individually small members still overflow the row budget in
        // aggregate; the rebuild must drop tail members, not emit them all.
        yield* insertTurnItem({
          id: "item:structured-compaction-window:many-results",
          ordinal: 2,
          type: "file_search",
          extra: {
            pattern: "needle",
            results: Array.from({ length: 2_000 }, (_, index) => ({
              fileName: `src/needle-${index}.ts`,
              line: index + 1,
            })),
          },
        });
        // A typed struct field nested four members deep
        // (questions[].options[].description) must still truncate rather than
        // pass through raw past the compaction depth limit.
        yield* insertTurnItem({
          id: "item:structured-compaction-window:deep-field",
          ordinal: 3,
          type: "user_input_request",
          extra: {
            requestId: "request:structured-compaction-window",
            questions: Array.from({ length: 10 }, (_, i) => ({
              id: `question:${i}`,
              header: "Pick",
              question: "Which?",
              options: Array.from({ length: 10 }, (_, j) => ({
                label: `Option ${j}`,
                description: "details ".repeat(1000),
                value: `${j}`,
              })),
            })),
          },
        });

        const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          maxRowPayloadBytes: 65_536,
        });
        const hugeResult = windowed.projection.turnItems.find(
          (item) => item.id === "item:structured-compaction-window:huge-result",
        );
        assert.isDefined(hugeResult);
        if (hugeResult?.type === "file_search") {
          assert.strictEqual(hugeResult.results?.[0]?.fileName, "src/needle.ts");
          assert.isAtMost(
            hugeResult.results?.[0]?.preview?.length ?? 0,
            THREAD_HISTORY_COMPACTED_FIELD_CHARS,
          );
        }
        const manyResults = windowed.projection.turnItems.find(
          (item) => item.id === "item:structured-compaction-window:many-results",
        );
        assert.isDefined(manyResults);
        if (manyResults?.type === "file_search") {
          assert.isDefined(manyResults.results);
          assert.isBelow(manyResults.results?.length ?? 0, 2_000);
          assert.strictEqual(manyResults.results?.[0]?.fileName, "src/needle-0.ts");
        }
        const deepField = windowed.projection.turnItems.find(
          (item) => item.id === "item:structured-compaction-window:deep-field",
        );
        assert.isDefined(deepField);
        if (deepField?.type === "user_input_request") {
          assert.strictEqual(deepField.questions.length, 10);
          assert.strictEqual(deepField.questions[0]?.options.length, 10);
          assert.isAtMost(
            deepField.questions[0]?.options[0]?.description.length ?? 0,
            THREAD_HISTORY_COMPACTED_FIELD_CHARS,
          );
        }
      }),
  );

  it.effect("pages through an oversized preceding turn instead of dead-ending at the anchor", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:anchored-oversized-turn");
      yield* projectionStore.apply({
        id: EventId.make("event:anchored-oversized-turn:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:anchored-oversized-turn"),
          title: "Anchored oversized turn",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      // Turn A is bigger than the hard window cap; turn B is small. The
      // initial snapshot aligns to turn B, and the cursor must then page
      // through every row of turn A rather than collapsing onto the anchor.
      const allIds: string[] = [];
      const rows = Array.from({ length: 13 }, (_, index) => {
        const ordinal = index + 1;
        const id = `item:anchored-oversized-turn:${ordinal}`;
        allIds.push(id);
        const isTurnStart = ordinal === 1 || ordinal === 11;
        const base = {
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
        };
        const item = isTurnStart
          ? {
              ...base,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              messageId: `message:${id}`,
              inputIntent: "turn_start",
              text: `Turn ${ordinal}`,
              attachments: [],
            }
          : {
              ...base,
              type: "command_execution",
              input: `command ${ordinal}`,
              output: "ok",
              exitCode: 0,
            };
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: null,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: item.type,
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString(item),
        };
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 77,
        userTurnLimit: 10,
        maxWindowRows: 4,
      });
      const bounded = buildBoundedThreadProjection({
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      });
      // The initial window aligns to turn B's boundary.
      assert.deepEqual(
        bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        allIds.slice(10),
      );

      const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      let cursor = bounded.historyCursor;
      let pages = 0;
      while (cursor !== null && pages < 10) {
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          userTurnLimit: 10,
          maxWindowRows: 4,
          ...anchorWindowOptions(cursor),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: snapshot.snapshotSequence,
          hasOlderHistory: snapshot.hasOlderHistory,
        });
        assert.isAbove(page.items.length, 0);
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
        pages += 1;
      }
      assert.isNull(cursor);
      assert.deepEqual(loaded, allIds);
    }),
  );

  it.effect("pages older history when long item ids survive compaction", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:long-id-cursor");
      yield* projectionStore.apply({
        id: EventId.make("event:long-id-cursor:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:long-id-cursor"),
          title: "Long id cursor",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      // Payloads over the caller's byte cap get post-pass compaction — ids
      // must survive verbatim or the emitted cursor cannot match turn_item_id
      // on the next anchored read and older history dead-ends. These ids are
      // longer than the cursor cap itself: v2 anchors on the ordinal instead,
      // so the emitted cursor stays small while the stored id stays whole.
      const allIds: string[] = [];
      const rows = Array.from({ length: 5 }, (_, index) => {
        const ordinal = index + 1;
        const id = `item:long-id-cursor:${"i".repeat(4_200)}:${ordinal}`;
        allIds.push(id);
        const isTurnStart = ordinal === 1 || ordinal === 4;
        const base = {
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
        };
        const item = isTurnStart
          ? {
              ...base,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              messageId: `message:${id}`,
              inputIntent: "turn_start",
              text: `Turn ${ordinal}`,
              attachments: [],
            }
          : {
              ...base,
              type: "command_execution",
              input: `command ${ordinal}`,
              output: "ok",
              exitCode: 0,
            };
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: null,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: item.type,
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString(item),
        };
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 2,
        maxRowPayloadBytes: 512,
      });
      const bounded = buildBoundedThreadProjection({
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      });
      const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      assert.deepEqual(loaded, allIds.slice(3));

      let cursor = bounded.historyCursor;
      let pages = 0;
      while (cursor !== null && pages < 10) {
        assert.isAtMost(cursor.length, THREAD_HISTORY_CURSOR_MAX_LENGTH);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 2,
          maxRowPayloadBytes: 512,
          ...anchorWindowOptions(cursor),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: snapshot.snapshotSequence,
          hasOlderHistory: snapshot.hasOlderHistory,
        });
        assert.isAbove(page.items.length, 0);
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
        pages += 1;
      }
      assert.isNull(cursor);
      assert.deepEqual(loaded, allIds);
    }),
  );

  it.effect("keeps an in-window interrupt request visible exactly once alongside its result", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:in-window-interrupt");
      yield* projectionStore.apply({
        id: EventId.make("event:in-window-interrupt:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:in-window-interrupt"),
          title: "In-window interrupt",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      const runId = RunId.make("run:in-window-interrupt");
      const requestId = TurnItemId.make("turn-item:in-window-interrupt:request");
      const resultId = TurnItemId.make("turn-item:in-window-interrupt:result");
      const insertItem = (input: {
        id: string;
        ordinal: number;
        type: string;
        extra?: Record<string, unknown>;
      }) => sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${input.id}, ${threadId}, ${input.extra?.["runId"] ?? null}, NULL, NULL, NULL,
            NULL, ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id: input.id,
              threadId,
              runId: input.extra?.["runId"] ?? null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: input.type,
              ...input.extra,
            })}
          )
        `;
      yield* insertItem({
        id: "item:in-window-interrupt:1",
        ordinal: 1,
        type: "user_message",
        extra: {
          createdBy: "user",
          creationSource: "web",
          messageId: "message:in-window-interrupt:1",
          inputIntent: "turn_start",
          text: "start",
          attachments: [],
        },
      });
      yield* insertItem({
        id: "item:in-window-interrupt:2",
        ordinal: 2,
        type: "command_execution",
        extra: { input: "cmd", output: "ok", exitCode: 0 },
      });
      yield* insertItem({
        id: requestId,
        ordinal: 3,
        type: "run_interrupt_request",
        extra: { runId, message: "Stopping" },
      });
      yield* insertItem({
        id: "item:in-window-interrupt:4",
        ordinal: 4,
        type: "command_execution",
        extra: { input: "cmd", output: "ok", exitCode: 0 },
      });
      yield* insertItem({
        id: resultId,
        ordinal: 5,
        type: "run_interrupt_result",
        extra: { runId, message: "Stopped" },
      });

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 77,
        userTurnLimit: 10,
      });
      // Both rows fit the window, so the request is a real timeline row:
      // retaining it as a hidden dependency would duplicate it and then hide
      // the visible copy.
      assert.strictEqual(
        windowed.projection.turnItems.filter((item) => item.id === requestId).length,
        1,
      );
      assert.isTrue(
        windowed.projection.visibleTurnItems.some((row) => row.sourceItemId === requestId),
      );
      assert.isTrue(
        windowed.projection.visibleTurnItems.some((row) => row.sourceItemId === resultId),
      );
    }),
  );

  it.effect("retains the interrupt request for a below-anchor progress result", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:progress-dep-interrupt");
      yield* projectionStore.apply({
        id: EventId.make("event:progress-dep-interrupt:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:progress-dep-interrupt"),
          title: "Progress dependency interrupt",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      // A result from a superseded attempt stays eligible only while a matching
      // request exists, and stays *visible* only while that request is in
      // turnItems. With a one-row window anchored on the newest item, the
      // progress row below the anchor is the result — its request must be
      // pulled in as a hidden dependency or the page surfaces nothing.
      const runId = RunId.make("run:progress-dep-interrupt");
      const nodeId = NodeId.make("node:progress-dep-interrupt");
      yield* projectionStore.apply({
        id: EventId.make("event:progress-dep-interrupt:attempt"),
        type: "run-attempt.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: RunAttemptId.make("attempt:progress-dep-interrupt"),
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId,
          providerThreadId: ProviderThreadId.make("provider-thread:progress-dep-interrupt"),
          providerTurnId: ProviderTurnId.make("provider-turn:progress-dep-interrupt"),
          reason: "initial",
          status: "superseded",
          startedAt: now,
          completedAt: now,
        },
      });
      const requestId = "turn-item:progress-dep-interrupt:request";
      const resultId = "turn-item:progress-dep-interrupt:result";
      const anchorId = "turn-item:progress-dep-interrupt:anchor";
      const insertItem = (input: {
        id: string;
        ordinal: number;
        type: string;
        runId?: RunId | null;
        nodeId?: NodeId | null;
      }) =>
        sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${input.id}, ${threadId}, ${input.runId ?? null}, ${input.nodeId ?? null},
            NULL, NULL, NULL, ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id: input.id,
              threadId,
              runId: input.runId ?? null,
              nodeId: input.nodeId ?? null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: input.type,
              ...(input.type === "command_execution"
                ? { input: "cmd", output: "ok", exitCode: 0 }
                : { message: input.type === "run_interrupt_request" ? "Stopping" : "Stopped" }),
            })}
          )
        `;
      yield* insertItem({
        id: requestId,
        ordinal: 1,
        type: "run_interrupt_request",
        runId,
      });
      yield* insertItem({
        id: resultId,
        ordinal: 2,
        type: "run_interrupt_result",
        runId,
        nodeId,
      });
      yield* insertItem({ id: anchorId, ordinal: 3, type: "command_execution" });

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
        maxWindowRows: 1,
        anchorItemId: TurnItemId.make(anchorId),
        anchorThreadId: threadId,
      });
      assert.deepEqual(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        [resultId, anchorId],
      );
      assert.isTrue(windowed.projection.turnItems.some((item) => String(item.id) === requestId));
      assert.isTrue(windowed.hasOlderHistory);

      // The page below the result surfaces the request as a normal row.
      const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
        maxWindowRows: 1,
        anchorItemId: TurnItemId.make(resultId),
        anchorThreadId: threadId,
      });
      assert.deepEqual(
        older.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        [requestId, resultId],
      );
    }),
  );

  it.effect("does not resurrect aligned-away rows below a fork cutoff", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const projectId = ProjectId.make("project:fork-alignment-progress");
      const sourceThreadId = ThreadId.make("thread:fork-alignment-progress:source");
      const targetThreadId = ThreadId.make("thread:fork-alignment-progress:target");
      const sourceRunAId = RunId.make("run:fork-alignment-progress:a");
      const sourceRunBId = RunId.make("run:fork-alignment-progress:b");

      yield* projectionStore.apply({
        id: EventId.make("event:fork-alignment-progress:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: sourceThreadId,
          projectId,
          title: "Fork alignment source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
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
        id: EventId.make("event:fork-alignment-progress:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Fork alignment target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRunBId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      for (const [ordinal, runId] of [
        [1, sourceRunAId],
        [2, sourceRunBId],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:fork-alignment-progress:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId: NodeId.make(`node:fork-alignment-progress:${ordinal}`),
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:fork-alignment-progress:${ordinal}`),
            rootNodeId: NodeId.make(`node:fork-alignment-progress:${ordinal}`),
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
      }

      // Turn A spans ordinals 1-9; turn B starts at ordinal 10 and is the
      // fork cutoff. A two-row window selects [9, 10], turn alignment drops
      // the partial turn A tail, and the fork cutoff must not re-surface it
      // the way a history-page anchor's progress row would.
      const rows = Array.from({ length: 10 }, (_, index) => {
        const ordinal = index + 1;
        const isTurnStart = ordinal === 1 || ordinal === 10;
        const runId = ordinal === 10 ? sourceRunBId : sourceRunAId;
        const id = `turn-item:fork-alignment-progress:${ordinal}`;
        return {
          turn_item_id: id,
          thread_id: sourceThreadId,
          run_id: runId,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: isTurnStart ? "user_message" : "command_execution",
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString({
            id,
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: isTurnStart ? "user_message" : "command_execution",
            ...(isTurnStart
              ? {
                  createdBy: "user",
                  creationSource: "web",
                  messageId: `message:fork-alignment-progress:${ordinal}`,
                  inputIntent: "turn_start",
                  text: `turn ${ordinal}`,
                  attachments: [],
                }
              : { input: `command ${ordinal}`, output: "ok", exitCode: 0 }),
          }),
        };
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 75,
        userTurnLimit: 10,
        maxWindowRows: 2,
      });
      assert.deepEqual(
        snapshot.projection.visibleTurnItems.map((row) => [
          row.visibility,
          row.item.type,
          String(row.sourceItemId),
        ]),
        [
          ["inherited", "user_message", "turn-item:fork-alignment-progress:10"],
          ["synthetic", "fork", `turn-item:fork:${targetThreadId}`],
        ],
      );
      assert.isTrue(snapshot.hasOlderHistory);
    }),
  );

  it.effect("drops an equal-ordinal sibling that sorts before the retained turn start", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const suffix = "align-sibling";
      const threadId = ThreadId.make(`thread:${suffix}`);
      yield* projectionStore.apply({
        id: EventId.make(`event:${suffix}:thread`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project:${suffix}`),
          title: "Alignment sibling window",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      // Turn A spans ordinals 1-9; turn B's turn start sits at ordinal 10.
      // A second row shares ordinal 10 but sorts before the turn start in the
      // (ordinal, turn_item_id) order, so it is the tail of the partial turn
      // below the alignment boundary — not part of turn B. An ordinal-only
      // cutoff would leak it into the initial window.
      const turnStartId = `item:${suffix}:zz-turn`;
      const siblingId = `item:${suffix}:0-tail`;
      const itemPayload = (id: string, ordinal: number, isTurnStart: boolean) => ({
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: nowIso,
        completedAt: nowIso,
        updatedAt: nowIso,
        type: isTurnStart ? "user_message" : "command_execution",
        ...(isTurnStart
          ? {
              createdBy: "user",
              creationSource: "web",
              messageId: `message:${suffix}:${ordinal}`,
              inputIntent: "turn_start",
              text: `turn ${ordinal}`,
              attachments: [],
            }
          : { input: `command ${ordinal}`, output: "ok", exitCode: 0 }),
      });
      const rows = [
        ...Array.from({ length: 9 }, (_, index) => {
          const ordinal = index + 1;
          const id = `item:${suffix}:${ordinal}`;
          return {
            turn_item_id: id,
            thread_id: threadId,
            run_id: null,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: ordinal === 1 ? "user_message" : "command_execution",
            status: "completed",
            updated_at: nowIso,
            payload_json: encodeUnknownJsonString(itemPayload(id, ordinal, ordinal === 1)),
          };
        }),
        ...[siblingId, turnStartId].map((id) => ({
          turn_item_id: id,
          thread_id: threadId,
          run_id: null,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal: 10,
          type: id === turnStartId ? "user_message" : "command_execution",
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString(itemPayload(id, 10, id === turnStartId)),
        })),
      ];
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
        userTurnLimit: 10,
        maxWindowRows: 2,
      });
      assert.deepEqual(
        snapshot.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        [turnStartId],
      );
      // The dropped sibling stays eligible history: paging reaches it through
      // the cursor instead of the initial window leaking it early.
      assert.isTrue(snapshot.hasOlderHistory);
    }),
  );

  const seedForkMarkerThreads = Effect.fn("seedForkMarkerThreads")(function* (
    suffix: string,
    options?: { readonly sourceOrdinalStart?: number },
  ) {
    const projectionStore = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const projectId = ProjectId.make(`project:fork-marker-anchor:${suffix}`);
    const sourceThreadId = ThreadId.make(`thread:fork-marker-anchor:${suffix}:source`);
    const targetThreadId = ThreadId.make(`thread:fork-marker-anchor:${suffix}:target`);
    const sourceRunId = RunId.make(`run:fork-marker-anchor:${suffix}:source`);
    const targetRunId = RunId.make(`run:fork-marker-anchor:${suffix}:target`);
    const basePayload = {
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      createdBy: "user" as const,
      creationSource: "web" as const,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* projectionStore.apply({
      id: EventId.make(`event:fork-marker-anchor:${suffix}:source-thread`),
      type: "thread.created",
      threadId: sourceThreadId,
      occurredAt: now,
      payload: {
        ...basePayload,
        id: sourceThreadId,
        projectId,
        title: "Marker anchor source",
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: sourceThreadId,
        },
        forkedFrom: null,
      },
    });
    yield* projectionStore.apply({
      id: EventId.make(`event:fork-marker-anchor:${suffix}:target-thread`),
      type: "thread.created",
      threadId: targetThreadId,
      occurredAt: now,
      payload: {
        ...basePayload,
        id: targetThreadId,
        projectId,
        title: "Marker anchor target",
        lineage: {
          parentThreadId: sourceThreadId,
          relationshipToParent: "fork",
          rootThreadId: sourceThreadId,
        },
        forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRunId },
      },
    });
    for (const [runId, threadId, side] of [
      [sourceRunId, sourceThreadId, "source"],
      [targetRunId, targetThreadId, "target"],
    ] as const) {
      yield* projectionStore.apply({
        id: EventId.make(`event:fork-marker-anchor:${suffix}:${side}-run`),
        type: "run.created",
        threadId,
        runId,
        nodeId: NodeId.make(`node:fork-marker-anchor:${suffix}:${side}`),
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:fork-marker-anchor:${suffix}:${side}`),
          rootNodeId: NodeId.make(`node:fork-marker-anchor:${suffix}:${side}`),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    }
    const ordinalStart = options?.sourceOrdinalStart ?? 1;
    const itemRows = (threadId: ThreadId, runId: RunId, count: number, start: number) =>
      Array.from({ length: count }, (_, index) => {
        const ordinal = index + start;
        const id = `turn-item:fork-marker-anchor:${suffix}:${threadId}:${ordinal}`;
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: runId,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: "command_execution",
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString({
            id,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            input: `command ${ordinal}`,
            output: "ok",
            exitCode: 0,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
          }),
        };
      });
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(itemRows(sourceThreadId, sourceRunId, 3, ordinalStart))}`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(itemRows(targetThreadId, targetRunId, 74, 1))}`;
    return { projectionStore, sourceThreadId, targetThreadId, ordinalStart };
  });

  const pageForkedHistory = Effect.fn("pageForkedHistory")(function* (
    suffix: string,
    options?: { readonly sourceOrdinalStart?: number },
  ) {
    const { projectionStore, sourceThreadId, targetThreadId, ordinalStart } =
      yield* seedForkMarkerThreads(suffix, options);

    // The 75-row page ends exactly on the fork marker, so the emitted cursor
    // anchors on a synthetic row (source ordinal 0) rather than a stored item.
    const first = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
      rowLimit: 75,
    });
    const firstPage = buildBoundedThreadProjection({
      policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
      projection: first.projection,
      snapshotSequence: first.snapshotSequence,
      hasOlderHistory: first.hasOlderHistory,
    });
    const oldest = firstPage.projection.visibleTurnItems[0]!;
    assert.strictEqual(oldest.item.type, "fork");
    assert.isTrue(firstPage.hasMoreHistory);
    const cursor = firstPage.historyCursor;
    assert.isNotNull(cursor);

    const next = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
      rowLimit: 75,
      ...anchorWindowOptions(cursor!),
    });
    const page = selectHistoryPageFromCursor({
      policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
      items: next.projection.visibleTurnItems,
      cursor: cursor!,
      snapshotSequence: next.snapshotSequence,
      hasOlderHistory: next.hasOlderHistory,
    });
    assert.deepEqual(
      page.items.map((row) => String(row.sourceItemId)),
      [ordinalStart, ordinalStart + 1, ordinalStart + 2].map(
        (ordinal) => `turn-item:fork-marker-anchor:${suffix}:${sourceThreadId}:${ordinal}`,
      ),
    );

    // The suppressed local segment still reports dropped rows, so one more
    // page is emitted; it must terminate empty instead of dead-ending or
    // looping on the marker anchor.
    if (page.nextCursor !== null) {
      const tail = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 75,
        ...anchorWindowOptions(page.nextCursor),
      });
      const tailPage = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: tail.projection.visibleTurnItems,
        cursor: page.nextCursor,
        snapshotSequence: tail.snapshotSequence,
        hasOlderHistory: tail.hasOlderHistory,
      });
      assert.lengthOf(tailPage.items, 0);
      assert.isNull(tailPage.nextCursor);
    }
  });

  it.effect("pages inherited rows when a v2 cursor anchors on the synthetic fork marker", () =>
    pageForkedHistory("v2-marker"),
  );

  it.effect(
    "pages all inherited rows when a stored source item shares the fork marker ordinal",
    () =>
      // The marker cursor carries source ordinal 0. A stored row at ordinal 0
      // must not become the boundary — the marker resolves no row, so the page
      // still surfaces every inherited item.
      pageForkedHistory("v2-marker-ordinal-0", { sourceOrdinalStart: 0 }),
  );

  const seedForkRuns = Effect.fn("seedForkRuns")(function* (
    suffix: string,
    input: {
      readonly sourceRuns: ReadonlyArray<{
        readonly runId: RunId;
        readonly runOrdinal: number;
        readonly itemOrdinals: ReadonlyArray<number>;
      }>;
      /** Index into sourceRuns naming the run the target thread forks from. */
      readonly forkRunIndex: number;
      readonly targetItemCount: number;
    },
  ) {
    const projectionStore = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const projectId = ProjectId.make(`project:fork-runs:${suffix}`);
    const sourceThreadId = ThreadId.make(`thread:fork-runs:${suffix}:source`);
    const targetThreadId = ThreadId.make(`thread:fork-runs:${suffix}:target`);
    const targetRunId = RunId.make(`run:fork-runs:${suffix}:target`);
    const forkRun = input.sourceRuns[input.forkRunIndex]!;
    const basePayload = {
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      createdBy: "user" as const,
      creationSource: "web" as const,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* projectionStore.apply({
      id: EventId.make(`event:fork-runs:${suffix}:source-thread`),
      type: "thread.created",
      threadId: sourceThreadId,
      occurredAt: now,
      payload: {
        ...basePayload,
        id: sourceThreadId,
        projectId,
        title: "Fork runs source",
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: sourceThreadId,
        },
        forkedFrom: null,
      },
    });
    yield* projectionStore.apply({
      id: EventId.make(`event:fork-runs:${suffix}:target-thread`),
      type: "thread.created",
      threadId: targetThreadId,
      occurredAt: now,
      payload: {
        ...basePayload,
        id: targetThreadId,
        projectId,
        title: "Fork runs target",
        lineage: {
          parentThreadId: sourceThreadId,
          relationshipToParent: "fork",
          rootThreadId: sourceThreadId,
        },
        forkedFrom: {
          type: "run",
          threadId: sourceThreadId,
          runId: forkRun.runId,
        },
      },
    });
    for (const [index, run] of input.sourceRuns.entries()) {
      yield* projectionStore.apply({
        id: EventId.make(`event:fork-runs:${suffix}:source-run-${index}`),
        type: "run.created",
        threadId: sourceThreadId,
        runId: run.runId,
        nodeId: NodeId.make(`node:fork-runs:${suffix}:source-${index}`),
        driver,
        occurredAt: now,
        payload: {
          id: run.runId,
          threadId: sourceThreadId,
          ordinal: run.runOrdinal,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:fork-runs:${suffix}:source-${index}`),
          rootNodeId: NodeId.make(`node:fork-runs:${suffix}:source-${index}`),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    }
    yield* projectionStore.apply({
      id: EventId.make(`event:fork-runs:${suffix}:target-run`),
      type: "run.created",
      threadId: targetThreadId,
      runId: targetRunId,
      nodeId: NodeId.make(`node:fork-runs:${suffix}:target`),
      driver,
      occurredAt: now,
      payload: {
        id: targetRunId,
        threadId: targetThreadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:fork-runs:${suffix}:target`),
        rootNodeId: NodeId.make(`node:fork-runs:${suffix}:target`),
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const itemRows = (threadId: ThreadId, runId: RunId, ordinals: ReadonlyArray<number>) =>
      ordinals.map((ordinal) => {
        const id = `turn-item:fork-runs:${suffix}:${threadId}:${ordinal}`;
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: runId,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: "command_execution",
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString({
            id,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            input: `command ${ordinal}`,
            output: "ok",
            exitCode: 0,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
          }),
        };
      });
    for (const run of input.sourceRuns) {
      if (run.itemOrdinals.length === 0) continue;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(
        itemRows(sourceThreadId, run.runId, run.itemOrdinals),
      )}`;
    }
    if (input.targetItemCount > 0) {
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(
        itemRows(
          targetThreadId,
          targetRunId,
          Array.from({ length: input.targetItemCount }, (_, index) => index + 1),
        ),
      )}`;
    }
    return { projectionStore, sql, sourceThreadId, targetThreadId };
  });

  const seedForkChain = Effect.fn("seedForkChain")(function* (
    suffix: string,
    input: {
      readonly depth: number;
      readonly itemsPerThread: number;
    },
  ) {
    const projectionStore = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const projectId = ProjectId.make(`project:fork-chain:${suffix}`);
    const threadIds = Array.from({ length: input.depth }, (_, index) =>
      ThreadId.make(`thread:fork-chain:${suffix}:${index}`),
    );
    const runIds = Array.from({ length: input.depth }, (_, index) =>
      RunId.make(`run:fork-chain:${suffix}:${index}`),
    );
    const basePayload = {
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      createdBy: "user" as const,
      creationSource: "web" as const,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    for (const [index, threadId] of threadIds.entries()) {
      yield* projectionStore.apply({
        id: EventId.make(`event:fork-chain:${suffix}:thread-${index}`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          ...basePayload,
          id: threadId,
          projectId,
          title: `Fork chain ${index}`,
          lineage: {
            parentThreadId: index === 0 ? null : threadIds[index - 1]!,
            relationshipToParent: index === 0 ? null : "fork",
            rootThreadId: threadIds[0]!,
          },
          forkedFrom:
            index === 0
              ? null
              : {
                  type: "run",
                  threadId: threadIds[index - 1]!,
                  runId: runIds[index - 1]!,
                },
        },
      });
      const runId = runIds[index]!;
      yield* projectionStore.apply({
        id: EventId.make(`event:fork-chain:${suffix}:run-${index}`),
        type: "run.created",
        threadId,
        runId,
        nodeId: NodeId.make(`node:fork-chain:${suffix}:${index}`),
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:fork-chain:${suffix}:${index}`),
          rootNodeId: NodeId.make(`node:fork-chain:${suffix}:${index}`),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(
        Array.from({ length: input.itemsPerThread }, (_, itemIndex) => {
          const ordinal = itemIndex + 1;
          const id = `turn-item:fork-chain:${suffix}:${index}:${ordinal}`;
          return {
            turn_item_id: id,
            thread_id: threadId,
            run_id: runId,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: "command_execution",
            status: "completed",
            updated_at: nowIso,
            payload_json: encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              input: `command ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            }),
          };
        }),
      )}`;
    }
    return { projectionStore, sql, threadIds, runIds };
  });

  it.effect("shares the window budget across fork ancestors instead of resetting it", () =>
    Effect.gen(function* () {
      const suffix = "budget";
      const depth = 6;
      const itemsPerThread = 8;
      const maxWindowRows = 12;
      const { projectionStore, threadIds } = yield* seedForkChain(suffix, {
        depth,
        itemsPerThread,
      });
      const leafThreadId = threadIds[depth - 1]!;
      // Fork markers surface as "synthetic" on the leaf edge but "inherited"
      // on deeper edges — exclude them by id rather than visibility.
      const keptItemCount = (rows: ReadonlyArray<{ readonly sourceItemId: unknown }>) =>
        rows.filter((row) => !String(row.sourceItemId).startsWith("turn-item:fork:")).length;

      // Every segment alone fits the row budget, so a per-ancestor reset would
      // merge depth × itemsPerThread decoded rows before the wire page trims.
      const windowed = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
        rowLimit: 75,
        maxWindowRows,
      });
      const firstWindowItems = keptItemCount(windowed.projection.visibleTurnItems);
      assert.isAtMost(firstWindowItems, maxWindowRows);
      // The leaf segment still keeps its own newest rows.
      assert.isAtLeast(firstWindowItems, itemsPerThread);
      assert.isTrue(windowed.hasOlderHistory);

      // Rows in ancestors beyond the remaining budget stay reachable: paging
      // from the merged window must eventually surface every chain item while
      // each window still honors the shared row budget.
      const seen = new Set(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
      );
      let cursor = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      }).historyCursor;
      assert.isNotNull(cursor);
      // Anchored windows carry one already-delivered boundary row (the cursor
      // anchor — for a marker cursor, the resolved fork-cutoff row) on top of
      // the new content; it does not consume the budget.
      for (let pages = 0; cursor !== null && pages < depth + 2; pages += 1) {
        const next = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
          rowLimit: 75,
          maxWindowRows,
          ...anchorWindowOptions(cursor),
        });
        assert.isAtMost(keptItemCount(next.projection.visibleTurnItems), maxWindowRows + 1);
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: next.projection.visibleTurnItems,
          cursor,
          snapshotSequence: next.snapshotSequence,
          hasOlderHistory: next.hasOlderHistory,
        });
        for (const item of page.items) {
          seen.add(String(item.sourceItemId));
        }
        cursor = page.nextCursor;
      }
      assert.isNull(cursor);
      for (const index of threadIds.keys()) {
        for (let ordinal = 1; ordinal <= itemsPerThread; ordinal += 1) {
          assert.isTrue(
            seen.has(`turn-item:fork-chain:${suffix}:${index}:${ordinal}`),
            `missing chain item ${index}:${ordinal}`,
          );
        }
      }
    }),
  );

  it.effect("bills preserved identity payloads at their emitted size instead of the row cap", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:identity-billing");
      const runId = RunId.make("run:identity-billing");
      const rootNodeId = NodeId.make("node:identity-billing");
      const rootThreadId = threadId;
      yield* projectionStore.apply({
        id: EventId.make("event:identity-billing:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:identity-billing"),
          title: "Identity billing",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId,
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
        id: EventId.make("event:identity-billing:run"),
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
          providerThreadId: null,
          userMessageId: MessageId.make("message:identity-billing"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      // Identity members are never truncated by write-time previews, so each
      // preview below keeps its ~1.5 MiB id — legitimately over the row cap.
      const oversizedIds = [1, 2, 3].map((ordinal) =>
        TurnItemId.make(`turn-item:identity-billing:${ordinal}:${"x".repeat(1_500_000)}`),
      );
      for (const [index, id] of oversizedIds.entries()) {
        yield* projectionStore.apply({
          id: EventId.make(`event:identity-billing:item-${index}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: index + 1,
            status: "completed",
            title: null,
            input: "echo",
            output: "ok",
            exitCode: 0,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "command_execution",
          },
        });
      }
      const previewSizes = yield* sql<{
        readonly preview_bytes: number;
      }>`
          SELECT LENGTH(CAST(bounded_json AS BLOB)) AS preview_bytes
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          ORDER BY ordinal
        `;
      assert.lengthOf(previewSizes, oversizedIds.length);
      for (const row of previewSizes) {
        assert.isAbove(row.preview_bytes, THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES);
      }

      // 3 × ~1.5 MiB exceeds the 4 MiB window budget: only the newest two
      // may ship; the third waits for paging instead of inflating the
      // window past the byte budget as a capped bill would have allowed.
      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      assert.deepEqual(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        [String(oversizedIds[1]!), String(oversizedIds[2]!)],
      );
      assert.isTrue(windowed.hasOlderHistory);
      const emittedBytes = windowed.projection.turnItems.reduce(
        (total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"),
        0,
      );
      assert.isAtMost(emittedBytes, THREAD_HISTORY_MAX_WINDOW_BYTES);

      // The dropped row stays reachable: anchored pages surface one
      // oversized identity at a time under the byte budget.
      const seen = new Set(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
      );
      let cursor = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      }).historyCursor;
      assert.isNotNull(cursor);
      for (let pages = 0; cursor !== null && pages < oversizedIds.length + 2; pages += 1) {
        const next = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 75,
          ...anchorWindowOptions(cursor),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: next.projection.visibleTurnItems,
          cursor,
          snapshotSequence: next.snapshotSequence,
          hasOlderHistory: next.hasOlderHistory,
        });
        for (const item of page.items) {
          seen.add(String(item.sourceItemId));
        }
        cursor = page.nextCursor;
      }
      assert.isNull(cursor);
      assert.deepEqual([...seen].sort(), oversizedIds.map(String).sort());
    }),
  );

  it.effect("pages past an oversized anchor row into fork ancestry", () =>
    Effect.gen(function* () {
      const suffix = "strand";
      const { projectionStore, threadIds } = yield* seedForkChain(suffix, {
        depth: 2,
        itemsPerThread: 1,
      });
      const leafThreadId = threadIds[1]!;
      const leafRunId = RunId.make(`run:fork-chain:${suffix}:1`);
      const now = yield* DateTime.now;
      // A preserved identity member inflates the leaf's only row past the
      // whole window byte budget. Billing the anchor row as spent budget would
      // skip every ancestor on the next page and dead-end the cursor on an
      // empty page — the anchor is delivered boundary, not page content.
      const giantItemId = TurnItemId.make(`turn-item:fork-chain:${suffix}:1:1`);
      yield* projectionStore.apply({
        id: EventId.make("event:fork-strand:leaf-giant"),
        type: "turn-item.updated",
        threadId: leafThreadId,
        runId: leafRunId,
        driver,
        occurredAt: now,
        payload: {
          id: giantItemId,
          threadId: leafThreadId,
          runId: leafRunId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: TurnItemId.make(
            `turn-item:fork-strand:${"p".repeat(THREAD_HISTORY_MAX_WINDOW_BYTES + 100)}`,
          ),
          ordinal: 1,
          status: "completed",
          title: null,
          input: "echo",
          output: "ok",
          exitCode: 0,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
        },
      });

      const windowed = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
        rowLimit: 75,
      });
      // The oversized leaf row ships alone: it is the only row that fits the
      // single-over-cap reachability slot.
      assert.deepEqual(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        [String(giantItemId)],
      );
      assert.isTrue(windowed.hasOlderHistory);

      const seen = new Set(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
      );
      let cursor = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      }).historyCursor;
      assert.isNotNull(cursor);
      for (let pages = 0; cursor !== null && pages < 6; pages += 1) {
        const next = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
          rowLimit: 75,
          ...anchorWindowOptions(cursor),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: next.projection.visibleTurnItems,
          cursor,
          snapshotSequence: next.snapshotSequence,
          hasOlderHistory: next.hasOlderHistory,
        });
        for (const item of page.items) {
          seen.add(String(item.sourceItemId));
        }
        cursor = page.nextCursor;
      }
      assert.isNull(cursor);
      assert.isTrue(seen.has(`turn-item:fork-chain:${suffix}:0:1`), "missing ancestor item");
      assert.isTrue(seen.has(String(giantItemId)), "missing oversized anchor item");
    }),
  );

  it.effect("emits only the single oversized progress row below an anchor", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:below-anchor-budget");
      const runId = RunId.make("run:below-anchor-budget");
      const rootNodeId = NodeId.make("node:below-anchor-budget");
      yield* projectionStore.apply({
        id: EventId.make("event:below-anchor-budget:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:below-anchor-budget"),
          title: "Below-anchor budget",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
        id: EventId.make("event:below-anchor-budget:run"),
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
          providerThreadId: null,
          userMessageId: MessageId.make("message:below-anchor-budget"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      // One oversized row sits below three ordinary rows. Anchored reads keep
      // the anchor row for boundary location plus the one row below it so the
      // page can progress — the emitted page must carry only that single
      // oversized row, never the anchor again.
      const giantParentId = TurnItemId.make(
        `turn-item:below-anchor-budget:${"p".repeat(THREAD_HISTORY_MAX_WINDOW_BYTES + 100)}`,
      );
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        const id = TurnItemId.make(`turn-item:below-anchor-budget:${ordinal}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:below-anchor-budget:item-${ordinal}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: ordinal === 1 ? giantParentId : null,
            ordinal,
            status: "completed",
            title: null,
            input: "echo",
            output: "ok",
            exitCode: 0,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "command_execution",
          },
        });
      }

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      // The oversized first row exceeds the remaining byte budget: only the
      // newest three rows ship.
      const expectedSmallIds = [2, 3, 4].map(
        (ordinal) => `turn-item:below-anchor-budget:${ordinal}`,
      );
      assert.deepEqual(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        expectedSmallIds,
      );
      assert.isTrue(windowed.hasOlderHistory);
      const windowBytes = windowed.projection.turnItems.reduce(
        (total, item) => total + bytesOfJson(item),
        0,
      );
      assert.isAtMost(windowBytes, THREAD_HISTORY_MAX_WINDOW_BYTES);

      // Page back through the anchor: the first page emits the rows below it
      // and the oversized row surfaces on the following page, still inside the
      // reachability slot — never stranded, never inflating a kept window.
      const cursor = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      }).historyCursor;
      assert.isNotNull(cursor);
      const anchored = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
        ...anchorWindowOptions(cursor!),
      });
      const page = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: anchored.projection.visibleTurnItems,
        cursor: cursor!,
        snapshotSequence: anchored.snapshotSequence,
        hasOlderHistory: anchored.hasOlderHistory,
      });
      assert.deepEqual(
        page.items.map((row) => String(row.sourceItemId)),
        [`turn-item:below-anchor-budget:1`],
      );
      // The oversized row was the oldest eligible row — history is exhausted.
      assert.isNull(page.nextCursor);
    }),
  );

  it.effect("bills undelivered equal-ordinal siblings against the shared window budget", () =>
    Effect.gen(function* () {
      const suffix = "sibbill";
      const { projectionStore, threadIds } = yield* seedForkChain(suffix, {
        depth: 2,
        itemsPerThread: 1,
      });
      const ancestorThreadId = threadIds[0]!;
      const leafThreadId = threadIds[1]!;
      const ancestorRunId = RunId.make(`run:fork-chain:${suffix}:0`);
      const leafRunId = RunId.make(`run:fork-chain:${suffix}:1`);
      const now = yield* DateTime.now;
      const giantParentId = TurnItemId.make(
        `turn-item:fork-sib:${"p".repeat(THREAD_HISTORY_MAX_WINDOW_BYTES + 100)}`,
      );
      const inflate = (input: {
        readonly eventId: string;
        readonly itemId: string;
        readonly threadId: ThreadId;
        readonly runId: RunId;
      }) =>
        projectionStore.apply({
          id: EventId.make(input.eventId),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(input.itemId),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: giantParentId,
            ordinal: 1,
            status: "completed",
            title: null,
            input: "echo",
            output: "ok",
            exitCode: 0,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "command_execution",
          },
        });
      // Two equal-ordinal leaf rows — the anchor (":1:1" sorts newer) and an
      // undelivered sibling (":1:0") below it — plus an oversized ancestor
      // row. Exempting every same-ordinal row from the shared budget lets the
      // ancestor ride along: three >budget payloads in one window against
      // the anchor-plus-progress floor.
      const anchorItemId = `turn-item:fork-chain:${suffix}:1:1`;
      const siblingItemId = `turn-item:fork-chain:${suffix}:1:0`;
      const ancestorItemId = `turn-item:fork-chain:${suffix}:0:1`;
      yield* inflate({
        eventId: "event:fork-sib:anchor",
        itemId: anchorItemId,
        threadId: leafThreadId,
        runId: leafRunId,
      });
      yield* inflate({
        eventId: "event:fork-sib:sibling",
        itemId: siblingItemId,
        threadId: leafThreadId,
        runId: leafRunId,
      });
      yield* inflate({
        eventId: "event:fork-sib:ancestor",
        itemId: ancestorItemId,
        threadId: ancestorThreadId,
        runId: ancestorRunId,
      });

      const windowed = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
        rowLimit: 75,
      });
      // Each row alone exceeds the byte budget, so the newest leaf row ships
      // by itself and becomes the next page's anchor.
      assert.deepEqual(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        [anchorItemId],
      );
      assert.isTrue(windowed.hasOlderHistory);
      const cursor = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      }).historyCursor;
      assert.isNotNull(cursor);

      const anchored = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
        rowLimit: 75,
        ...anchorWindowOptions(cursor!),
      });
      // The undelivered sibling bills the whole remaining budget; the
      // oversized ancestor row waits for the next page instead of inflating
      // this window to three >budget payloads.
      assert.deepEqual(
        new Set(anchored.projection.visibleTurnItems.map((row) => String(row.sourceItemId))),
        new Set([anchorItemId, siblingItemId]),
      );

      // The skipped ancestor stays reachable: page forward until the cursor
      // dies and confirm every row arrives.
      const seen = new Set([anchorItemId]);
      const anchoredPage = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: anchored.projection.visibleTurnItems,
        cursor: cursor!,
        snapshotSequence: anchored.snapshotSequence,
        hasOlderHistory: anchored.hasOlderHistory,
      });
      for (const item of anchoredPage.items) {
        seen.add(String(item.sourceItemId));
      }
      let nextCursor = anchoredPage.nextCursor;
      for (let pages = 0; nextCursor !== null && pages < 6; pages += 1) {
        const next = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
          rowLimit: 75,
          ...anchorWindowOptions(nextCursor),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: next.projection.visibleTurnItems,
          cursor: nextCursor,
          snapshotSequence: next.snapshotSequence,
          hasOlderHistory: next.hasOlderHistory,
        });
        for (const item of page.items) {
          seen.add(String(item.sourceItemId));
        }
        nextCursor = page.nextCursor;
      }
      assert.isNull(nextCursor);
      assert.isTrue(seen.has(siblingItemId), "missing equal-ordinal sibling");
      assert.isTrue(seen.has(ancestorItemId), "missing oversized ancestor item");
    }),
  );

  it.effect("bills equal-ordinal siblings in stored UTF-8 order, not UTF-16", () =>
    Effect.gen(function* () {
      const suffix = "u8bill";
      const { projectionStore, sql, threadIds, runIds } = yield* seedForkChain(suffix, {
        depth: 3,
        itemsPerThread: 1,
      });
      const rootThreadId = threadIds[0]!;
      const middleThreadId = threadIds[1]!;
      const leafThreadId = threadIds[2]!;
      const rootRunId = runIds[0]!;
      const middleRunId = runIds[1]!;
      const now = yield* DateTime.now;
      const giantParentId = TurnItemId.make(
        `turn-item:fork-u8:${"p".repeat(THREAD_HISTORY_MAX_WINDOW_BYTES + 100)}`,
      );
      // The equal-ordinal pair lives in the MIDDLE segment: the bug needs the
      // anchor-owning segment's spent to gate a deeper ancestor's budget. A
      // leaf-side anchor would strand behind the leaf's own truncation.
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${middleThreadId}`;
      const inflate = (input: {
        readonly eventId: string;
        readonly itemId: string;
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly oversized?: boolean;
      }) =>
        projectionStore.apply({
          id: EventId.make(input.eventId),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(input.itemId),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: input.oversized === false ? null : giantParentId,
            ordinal: 1,
            status: "completed",
            title: null,
            input: "echo",
            output: "ok",
            exitCode: 0,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "command_execution",
          },
        });
      // The anchor's id ends in U+10000 — UTF-8 bytes F0 90 80 80, the
      // largest stored id in its ordinal group — but its UTF-16 lead unit
      // (D800) sorts BELOW the sibling's U+E000 (E000). Comparing ids as
      // UTF-16 code units crowns the sibling as the boundary: the small
      // anchor is billed instead, the oversized sibling is exempted, and
      // enough budget remains for the root's oversized row to ride along —
      // three >budget payloads in one window.
      const anchorItemId = `turn-item:u8:${suffix}:𐀀`;
      const siblingItemId = `turn-item:u8:${suffix}:`;
      const ancestorItemId = `turn-item:fork-chain:${suffix}:0:1`;
      yield* inflate({
        eventId: "event:fork-u8:anchor",
        itemId: anchorItemId,
        threadId: middleThreadId,
        runId: middleRunId,
        oversized: false,
      });
      yield* inflate({
        eventId: "event:fork-u8:sibling",
        itemId: siblingItemId,
        threadId: middleThreadId,
        runId: middleRunId,
      });
      yield* inflate({
        eventId: "event:fork-u8:ancestor",
        itemId: ancestorItemId,
        threadId: rootThreadId,
        runId: rootRunId,
      });

      const windowed = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
        rowLimit: 75,
      });
      const cursor = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      }).historyCursor;
      assert.isNotNull(cursor);

      const anchored = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
        rowLimit: 75,
        ...anchorWindowOptions(cursor!),
      });
      const anchoredIds = new Set(
        anchored.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
      );
      // The oversized sibling consumes the budget; the root's oversized row
      // waits for the next page instead of inflating this window past the
      // anchor-plus-progress floor.
      assert.isTrue(anchoredIds.has(siblingItemId), "missing progress row below the anchor");
      assert.isFalse(
        anchoredIds.has(ancestorItemId),
        "oversized ancestor row joined the window while the sibling was exempted",
      );

      // The skipped ancestor stays reachable: page forward until the cursor
      // dies and confirm every row arrives.
      const seen = new Set(anchoredIds);
      const anchoredPage = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: anchored.projection.visibleTurnItems,
        cursor: cursor!,
        snapshotSequence: anchored.snapshotSequence,
        hasOlderHistory: anchored.hasOlderHistory,
      });
      for (const item of anchoredPage.items) {
        seen.add(String(item.sourceItemId));
      }
      let nextCursor = anchoredPage.nextCursor;
      for (let pages = 0; nextCursor !== null && pages < 6; pages += 1) {
        const next = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
          rowLimit: 75,
          ...anchorWindowOptions(nextCursor),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: next.projection.visibleTurnItems,
          cursor: nextCursor,
          snapshotSequence: next.snapshotSequence,
          hasOlderHistory: next.hasOlderHistory,
        });
        for (const item of page.items) {
          seen.add(String(item.sourceItemId));
        }
        nextCursor = page.nextCursor;
      }
      assert.isNull(nextCursor);
      assert.isTrue(seen.has(ancestorItemId), "missing oversized ancestor item");
    }),
  );

  it.effect("bills equal-ordinal rows whose decoded ids collide with the anchor's", () =>
    Effect.gen(function* () {
      const suffix = "u8dup";
      const { projectionStore, sql, threadIds, runIds } = yield* seedForkChain(suffix, {
        depth: 3,
        itemsPerThread: 1,
      });
      const rootThreadId = threadIds[0]!;
      const middleThreadId = threadIds[1]!;
      const leafThreadId = threadIds[2]!;
      const rootRunId = runIds[0]!;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      // Two stored middle-segment rows decode to the same item id — the shape
      // produced when a driver's binding folds distinct written bytes to one
      // decoded string (e.g. Bun-written lone surrogates read under Node).
      // Both are too large for one wire page, so the first page stops at the
      // fork marker and the next read treats the middle segment's whole
      // collision group as content below the boundary. The boundary pick is
      // the stored-max row ("b"); the stored-min twin ("a") alone fills the
      // byte budget, so exempting the wrong row — or the whole group — lets
      // the root's oversized row ride along inside the same window.
      const giantParentId = `turn-item:fork-u8dup:${"p".repeat(THREAD_HISTORY_MAX_WINDOW_BYTES + 100)}`;
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${middleThreadId}`;
      const twinItemId = `turn-item:u8dup:${suffix}:twin`;
      for (const storedSuffix of ["a", "b"]) {
        const itemId = `turn-item:u8dup:${suffix}:twin:${storedSuffix}`;
        const parentItemId =
          storedSuffix === "a"
            ? giantParentId
            : `turn-item:fork-u8dup:${"p".repeat(THREAD_HISTORY_MAX_WINDOW_BYTES / 2)}`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert([
          {
            turn_item_id: itemId,
            thread_id: middleThreadId,
            run_id: runIds[1]!,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal: 1,
            type: "command_execution",
            status: "completed",
            updated_at: nowIso,
            payload_json: encodeUnknownJsonString({
              id: twinItemId,
              threadId: middleThreadId,
              runId: runIds[1],
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId,
              ordinal: 1,
              status: "completed",
              title: null,
              input: "echo",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            }),
          },
        ])}`;
      }
      const ancestorItemId = `turn-item:fork-chain:${suffix}:0:1`;
      yield* projectionStore.apply({
        id: EventId.make("event:fork-u8dup:ancestor"),
        type: "turn-item.updated",
        threadId: rootThreadId,
        runId: rootRunId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(ancestorItemId),
          threadId: rootThreadId,
          runId: rootRunId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: TurnItemId.make(giantParentId),
          ordinal: 1,
          status: "completed",
          title: null,
          input: "echo",
          output: "ok",
          exitCode: 0,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
        },
      });

      // Page forward until a window anchors on the twin group: the boundary
      // segment then owns both colliding rows. If every row matching the
      // anchor's decoded id were exempted, the whole group would bill zero
      // and the root's oversized row would ride along on the same page.
      const windowed = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
        rowLimit: 75,
      });
      const firstPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      });
      const seen = new Set(
        firstPage.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
      );
      let cursor = firstPage.historyCursor;
      let twinPageHadAncestor = false;
      for (let pages = 0; cursor !== null && pages < 8; pages += 1) {
        const next = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
          rowLimit: 75,
          ...anchorWindowOptions(cursor),
        });
        const ids = new Set(
          next.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        );
        // Both twins decode to the same item id, so count occurrences: the
        // anchor alone is exempt, but a second retained twin is billed content
        // whose bytes leave no room for the ancestor row.
        const twinRows = next.projection.visibleTurnItems.filter(
          (row) => String(row.sourceItemId) === twinItemId,
        ).length;
        if (twinRows > 1 && ids.has(ancestorItemId)) twinPageHadAncestor = true;
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: next.projection.visibleTurnItems,
          cursor,
          snapshotSequence: next.snapshotSequence,
          hasOlderHistory: next.hasOlderHistory,
        });
        for (const item of page.items) {
          seen.add(String(item.sourceItemId));
        }
        cursor = page.nextCursor;
      }
      assert.isFalse(
        twinPageHadAncestor,
        "oversized ancestor row shared a page with the whole exempted twin group",
      );
      assert.isNull(cursor);
      assert.isTrue(seen.has(twinItemId), "missing colliding twin row");
      assert.isTrue(seen.has(ancestorItemId), "missing oversized ancestor item");
    }),
  );

  it.effect("bills rolled-back ancestor rows that the fork still inherits", () =>
    Effect.gen(function* () {
      const suffix = "rolledbudget";
      const depth = 3;
      const itemsPerThread = 4;
      // The middle segment must keep its whole eligible set — a truncated
      // local window stops traversal before ancestor budgeting runs at all.
      const rolledItems = 4;
      const maxWindowRows = 12;
      const { projectionStore, sql, threadIds } = yield* seedForkChain(suffix, {
        depth,
        itemsPerThread,
      });
      const leafThreadId = threadIds[2]!;
      const middleThreadId = threadIds[1]!;
      const rolledRunId = `run:fork-chain:${suffix}:1`;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      // Roll back the middle thread's fork run after the leaf forked: its rows
      // are hidden from the middle thread's own timeline but remain in the
      // leaf's inherited prefix — billing the locally-visible set would exempt
      // them from the shared budget and let the root ancestor ride.
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'rolled_back',
          payload_json = json_set(payload_json, '$.status', 'rolled_back')
        WHERE run_id = ${rolledRunId} AND thread_id = ${middleThreadId}
      `;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(
        Array.from({ length: rolledItems }, (_, itemIndex) => {
          const ordinal = itemsPerThread + itemIndex + 1;
          const id = `turn-item:fork-chain:${suffix}:1:r${ordinal}`;
          return {
            turn_item_id: id,
            thread_id: middleThreadId,
            run_id: rolledRunId,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: "command_execution",
            status: "completed",
            updated_at: nowIso,
            payload_json: encodeUnknownJsonString({
              id,
              threadId: middleThreadId,
              runId: rolledRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              input: `rolled command ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            }),
          };
        }),
      )}`;

      const keptItemCount = (rows: ReadonlyArray<{ readonly sourceItemId: unknown }>) =>
        rows.filter((row) => !String(row.sourceItemId).startsWith("turn-item:fork:")).length;

      const windowed = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
        rowLimit: 75,
        maxWindowRows,
      });
      // Leaf 4 + middle 8 (4 normal + 4 rolled-back, all kept) = 12; the
      // root's rows must wait for the next page instead of pushing the merged
      // window past the shared budget.
      assert.isAtMost(keptItemCount(windowed.projection.visibleTurnItems), maxWindowRows);
      assert.isTrue(windowed.hasOlderHistory);

      const seen = new Set(
        windowed.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
      );
      let cursor = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined, maxItems: 75 },
        projection: windowed.projection,
        snapshotSequence: windowed.snapshotSequence,
        hasOlderHistory: windowed.hasOlderHistory,
      }).historyCursor;
      assert.isNotNull(cursor);
      for (let pages = 0; cursor !== null && pages < depth + 2; pages += 1) {
        const next = yield* projectionStore.getThreadSnapshotWindow(leafThreadId, {
          rowLimit: 75,
          maxWindowRows,
          ...anchorWindowOptions(cursor),
        });
        assert.isAtMost(keptItemCount(next.projection.visibleTurnItems), maxWindowRows + 1);
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: next.projection.visibleTurnItems,
          cursor,
          snapshotSequence: next.snapshotSequence,
          hasOlderHistory: next.hasOlderHistory,
        });
        for (const item of page.items) {
          seen.add(String(item.sourceItemId));
        }
        cursor = page.nextCursor;
      }
      assert.isNull(cursor);
      // Every chain row arrives: leaf items, the middle thread's normal and
      // rolled-back items, and the root's items.
      const expected = [
        ...threadIds.flatMap((_, index) =>
          Array.from(
            { length: itemsPerThread },
            (_, itemIndex) => `turn-item:fork-chain:${suffix}:${index}:${itemIndex + 1}`,
          ),
        ),
        ...Array.from(
          { length: rolledItems },
          (_, itemIndex) => `turn-item:fork-chain:${suffix}:1:r${itemsPerThread + itemIndex + 1}`,
        ),
      ];
      for (const id of expected) {
        assert.isTrue(seen.has(id), `missing chain item ${id}`);
      }
    }),
  );

  it.effect("keeps earlier runs' rows reachable when source item ordinals are not monotonic", () =>
    Effect.gen(function* () {
      const suffix = "nonmonotonic";
      const earlyRunId = RunId.make(`run:fork-runs:${suffix}:early`);
      const forkRunId = RunId.make(`run:fork-runs:${suffix}:fork`);
      const { projectionStore, sourceThreadId, targetThreadId } = yield* seedForkRuns(suffix, {
        sourceRuns: [
          // The earlier run's items sit at ordinals above the fork run's —
          // a run-ordinal cutoff can never be expressed as an item-ordinal
          // boundary when item ordinals do not grow with run ordinals.
          { runId: earlyRunId, runOrdinal: 1, itemOrdinals: [251, 252] },
          { runId: forkRunId, runOrdinal: 2, itemOrdinals: [201] },
        ],
        forkRunIndex: 1,
        targetItemCount: 2,
      });

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 16,
      });
      assert.deepEqual(
        snapshot.projection.visibleTurnItems.map((row) => [
          row.visibility,
          String(row.sourceItemId),
        ]),
        [
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:201`],
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:251`],
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:252`],
          ["synthetic", `turn-item:fork:${targetThreadId}`],
          ["local", `turn-item:fork-runs:${suffix}:${targetThreadId}:1`],
          ["local", `turn-item:fork-runs:${suffix}:${targetThreadId}:2`],
        ],
      );
    }),
  );

  it.effect("hydrates cohort runs whose stored ids were mangled by the driver", () =>
    Effect.gen(function* () {
      const suffix = "surrogate-run";
      // The bound column folds the lone surrogate to U+FFFD while the stored
      // payload keeps it as a JSON escape — the decoded runId no longer equals
      // the column under json_each, so cohort hydration must join on rowids.
      const earlyRunId = RunId.make(`run:fork-runs:${suffix}:early\ud800`);
      const forkRunId = RunId.make(`run:fork-runs:${suffix}:fork`);
      const { projectionStore, sourceThreadId, targetThreadId } = yield* seedForkRuns(suffix, {
        sourceRuns: [
          { runId: earlyRunId, runOrdinal: 1, itemOrdinals: [1, 2] },
          { runId: forkRunId, runOrdinal: 2, itemOrdinals: [3] },
        ],
        forkRunIndex: 1,
        targetItemCount: 1,
      });

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 16,
      });
      assert.deepEqual(
        snapshot.projection.visibleTurnItems.map((row) => [
          row.visibility,
          String(row.sourceItemId),
        ]),
        [
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:1`],
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:2`],
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:3`],
          ["synthetic", `turn-item:fork:${targetThreadId}`],
          ["local", `turn-item:fork-runs:${suffix}:${targetThreadId}:1`],
        ],
      );
      yield* purgeProjectionRows([sourceThreadId, targetThreadId]);
    }),
  );

  it.effect("resolves the fork run when its stored id was written by another driver", () =>
    Effect.gen(function* () {
      const suffix = "crossdriver-run";
      const earlyRunId = RunId.make(`run:fork-runs:${suffix}:early`);
      const forkRunId = RunId.make(`run:fork-runs:${suffix}:fork\ud800`);
      const { projectionStore, sql, sourceThreadId, targetThreadId } = yield* seedForkRuns(suffix, {
        sourceRuns: [
          { runId: earlyRunId, runOrdinal: 1, itemOrdinals: [1] },
          { runId: forkRunId, runOrdinal: 2, itemOrdinals: [2] },
        ],
        forkRunIndex: 1,
        targetItemCount: 1,
      });

      // Simulate a database written under a driver that stores the surrogate
      // verbatim: the run_id column holds raw WTF-8 bytes while this driver's
      // bound text folds to U+FFFD, so only stored-identity resolution can
      // find the fork run. json_extract decodes the payload escape to the
      // same raw bytes the other driver stored.
      const forkRunIdJson = encodeUnknownJsonString(forkRunId);
      yield* sql`UPDATE orchestration_v2_projection_runs
        SET run_id = json_extract(${forkRunIdJson}, '$')
        WHERE run_id = ${forkRunId}`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET run_id = json_extract(${forkRunIdJson}, '$')
        WHERE run_id = ${forkRunId}`;

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 16,
      });
      assert.deepEqual(
        snapshot.projection.visibleTurnItems.map((row) => [
          row.visibility,
          String(row.sourceItemId),
        ]),
        [
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:1`],
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:2`],
          ["synthetic", `turn-item:fork:${targetThreadId}`],
          ["local", `turn-item:fork-runs:${suffix}:${targetThreadId}:1`],
        ],
      );
      yield* purgeProjectionRows([sourceThreadId, targetThreadId]);
    }),
  );

  it.effect("prefers the exact fork run when another run's id aliases its bound form", () =>
    Effect.gen(function* () {
      const suffix = "alias-run";
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      // Binding the fork run's id folds its lone surrogate to U+FFFD — the
      // literal id of an earlier run — so a bound-column match under
      // OR…LIMIT 1 can select the wrong source run and drop every item that
      // only joins the real fork run.
      const aliasRunId = RunId.make(`run:fork-runs:${suffix}:alias` + String.fromCharCode(0xfffd));
      const forkRunId = RunId.make(`run:fork-runs:${suffix}:alias\ud800`);
      const { projectionStore, sql, sourceThreadId, targetThreadId } = yield* seedForkRuns(suffix, {
        sourceRuns: [{ runId: forkRunId, runOrdinal: 2, itemOrdinals: [2] }],
        forkRunIndex: 0,
        targetItemCount: 1,
      });

      // Simulate a database written under a driver that stores the surrogate
      // verbatim in the id columns: the fork run and its items hold raw WTF-8
      // while the bound id folds, so only stored-payload identity resolution
      // picks the right run. Payload ids already carry the \ud800 escape —
      // rewriting only the columns keeps both sides of the resolution honest.
      const forkRunIdJson = encodeUnknownJsonString(forkRunId);
      yield* sql`UPDATE orchestration_v2_projection_runs
        SET run_id = json_extract(${forkRunIdJson}, '$')
        WHERE json_extract(payload_json, '$.id') = json_extract(${forkRunIdJson}, '$')`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET run_id = json_extract(${forkRunIdJson}, '$')
        WHERE thread_id = ${sourceThreadId}
          AND json_extract(payload_json, '$.runId') = json_extract(${forkRunIdJson}, '$')`;

      // The alias run cannot come through the apply path: its folded run_id
      // equals the fork run's folded form, so the upsert would merge them.
      // Direct SQL keeps it a distinct row, at a lower rowid so the folded
      // bound arm deterministically visited it first under the old predicate.
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          rowid, run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          0, ${aliasRunId}, ${sourceThreadId}, 1, 'codex', NULL, 'completed',
          ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: aliasRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: `message:fork-runs:${suffix}:alias`,
            rootNodeId: `node:fork-runs:${suffix}:alias`,
            activeAttemptId: null,
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      const aliasItemId = `turn-item:fork-runs:${suffix}:${sourceThreadId}:1`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${aliasItemId}, ${sourceThreadId}, ${aliasRunId}, NULL, NULL, NULL, NULL, 1,
          'command_execution', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: aliasItemId,
            threadId: sourceThreadId,
            runId: aliasRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            input: "command 1",
            output: "ok",
            exitCode: 0,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
          })}
        )
      `;

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 16,
      });
      assert.deepEqual(
        snapshot.projection.visibleTurnItems.map((row) => [
          row.visibility,
          String(row.sourceItemId),
        ]),
        [
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:1`],
          ["inherited", `turn-item:fork-runs:${suffix}:${sourceThreadId}:2`],
          ["synthetic", `turn-item:fork:${targetThreadId}`],
          ["local", `turn-item:fork-runs:${suffix}:${targetThreadId}:1`],
        ],
      );
      yield* purgeProjectionRows([sourceThreadId, targetThreadId]);
    }),
  );

  it.effect("hydrates retained messages whose ids carry lone surrogates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:surrogate-message");
      const runId = RunId.make("run:surrogate-message:1");
      const rootNodeId = NodeId.make("node:surrogate-message:root");
      const messageId = MessageId.make("message:surrogate-message:\ud800");
      const userTurnItemId = TurnItemId.make("turn-item:surrogate-message:user");
      yield* projectionStore.apply({
        id: EventId.make("event:surrogate-message:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:surrogate-message"),
          title: "Surrogate message",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
        id: EventId.make("event:surrogate-message:run"),
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
          providerThreadId: null,
          userMessageId: messageId,
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:surrogate-message:message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: messageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "surrogate user",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:surrogate-message:item"),
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
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: "surrogate user",
          attachments: [],
        },
      });

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 16,
      });
      // Rewind resolves a retained user item's messageId against
      // projection.messages — the bound column folds the surrogate while the
      // payload keeps it as a JSON escape, so hydration must compare decoded
      // payload ids, not the stored column.
      assert.deepEqual(
        snapshot.projection.visibleTurnItems.map((row) => row.item.type),
        ["user_message"],
      );
      assert.deepEqual(
        snapshot.projection.messages.map((message) => String(message.id)),
        [String(messageId)],
      );
      yield* purgeProjectionRows([threadId]);
    }),
  );

  it.effect("hydrates retained nodes whose ids carry lone surrogates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:surrogate-node");
      const runId = RunId.make("run:surrogate-node:1");
      const rootNodeId = NodeId.make("node:surrogate-node:\ud800");
      yield* projectionStore.apply({
        id: EventId.make("event:surrogate-node:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:surrogate-node"),
          title: "Surrogate node",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
        id: EventId.make("event:surrogate-node:run"),
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
          providerThreadId: null,
          userMessageId: MessageId.make("message:surrogate-node:user"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:surrogate-node:node"),
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
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:surrogate-node:item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make("turn-item:surrogate-node:user"),
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:surrogate-node:user"),
          inputIntent: "turn_start",
          text: "surrogate node user",
          attachments: [],
        },
      });

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 16,
      });
      // The cohort walk returns decoded ids to JavaScript; raw surrogate bytes
      // do not survive that boundary (node:sqlite reads U+FFFD triples), so
      // the list crosses as hex of the decoded bytes and consumers compare
      // hex(json_extract(payload,'$.id')).
      assert.deepEqual(
        snapshot.projection.nodes.map((node) => String(node.id)),
        [String(rootNodeId)],
      );
      yield* purgeProjectionRows([threadId]);
    }),
  );

  it.effect("does not hydrate foreign provider threads through a missing node reference", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:null-node-ref");
      const threadA = ThreadId.make("thread:null-node-ref:a");
      const threadB = ThreadId.make("thread:null-node-ref:b");
      const runId = RunId.make("run:null-node-ref:1");
      const rootNodeId = NodeId.make("node:null-node-ref:root");
      const foreignProviderThreadId = ProviderThreadId.make(
        "provider-thread:null-node-ref:foreign",
      );
      const baseThread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        projectId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:null-node-ref:thread-a"),
        type: "thread.created",
        threadId: threadA,
        occurredAt: now,
        payload: {
          ...baseThread,
          id: threadA,
          title: "Null node ref A",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadA,
          },
          forkedFrom: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:null-node-ref:thread-b"),
        type: "thread.created",
        threadId: threadB,
        occurredAt: now,
        payload: {
          ...baseThread,
          id: threadB,
          title: "Null node ref B",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadB,
          },
          forkedFrom: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:null-node-ref:run"),
        type: "run.created",
        threadId: threadA,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: threadA,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:null-node-ref:user"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      // The root node has no parentNodeId — the cohort seed for it used to
      // emit hex(NULL) = '', which then matched every ownerNodeId-less row.
      yield* projectionStore.apply({
        id: EventId.make("event:null-node-ref:node"),
        type: "node.updated",
        threadId: threadA,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId: threadA,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:null-node-ref:item"),
        type: "turn-item.updated",
        threadId: threadA,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make("turn-item:null-node-ref:user"),
          threadId: threadA,
          runId,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:null-node-ref:user"),
          inputIntent: "turn_start",
          text: "null node ref user",
          attachments: [],
        },
      });
      // A foreign thread's ownerless provider thread must stay out of A's
      // bounded projection — the ownerNodeId cohort arm is not thread-scoped.
      yield* projectionStore.apply({
        id: EventId.make("event:null-node-ref:foreign-provider-thread"),
        type: "provider-thread.updated",
        threadId: threadB,
        driver,
        occurredAt: now,
        payload: {
          id: foreignProviderThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadB,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      // A foreign row whose payload cannot be parsed (migration 054 leaves
      // bounded_json NULL for those) must be skipped by the cohort arms, not
      // abort the bounded read for an unrelated thread.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_threads (
          provider_thread_id, thread_id, owner_node_id, provider,
          provider_session_id, status, first_run_ordinal, last_run_ordinal,
          updated_at, payload_json
        ) VALUES (
          'provider-thread:null-node-ref:malformed', ${threadB}, NULL, 'codex',
          NULL, 'idle', NULL, NULL, ${DateTime.formatIso(now)}, '{broken'
        )
      `;

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadA, {
        rowLimit: 16,
      });
      assert.deepEqual(
        snapshot.projection.providerThreads.map((providerThread) => String(providerThread.id)),
        [],
      );
      // The test database is shared across this file; the unparseable row
      // breaks shell snapshots (which decode every provider_threads payload),
      // so remove it once the bounded path has been exercised.
      yield* sql`
        DELETE FROM orchestration_v2_projection_provider_threads
        WHERE provider_thread_id = 'provider-thread:null-node-ref:malformed'
      `;
    }),
  );

  it.effect("bounds the thread payload on snapshot windows", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:bounded-title");
      const hugeTitle = "t".repeat(200_000);
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-title:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:bounded-title"),
          title: hugeTitle,
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      const bounded = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      assert.isBelow(bounded.projection.thread.title.length, hugeTitle.length);
      // A caller-tighter cap applies to every fetched collection, not just
      // turn items — the stored default-cap preview must compact again.
      const tight = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
        maxRowPayloadBytes: 4_096,
      });
      assert.isAtMost(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Buffer.byteLength(JSON.stringify(tight.projection.thread), "utf8"),
        4_096 + 256,
      );
      // The full projection path still returns the complete stored payload.
      const full = yield* projectionStore.getThreadProjection(threadId);
      assert.strictEqual(full.thread.title, hugeTitle);
    }),
  );

  it.effect("keeps merged write-time previews inside the row cap", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:merge-preview-cap");
      yield* projectionStore.apply({
        id: EventId.make("event:merge-preview-cap:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:merge-preview-cap"),
          title: "Merge preview cap",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      const subagentId = NodeId.make("node:merge-preview-cap:subagent");
      const makeSubagent = (prompt: string) => ({
        id: subagentId,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:merge-preview-cap:parent"),
        origin: "app_owned" as const,
        createdBy: "user" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt,
        title: null,
        model: null,
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      });
      // The first write carries completionDelivery and stays under the cap, so
      // it stores no preview. The second write omits it and is sized to land
      // just under the cap — grafting the retained member would push the merged
      // preview over, so the store must keep the bounded fallback instead.
      yield* projectionStore.apply({
        id: EventId.make("event:merge-preview-cap:subagent-1"),
        type: "subagent.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          ...makeSubagent("seed"),
          completionDelivery: { state: "pending" as const, observedByRunId: null },
        },
      });
      const emptyLen = Buffer.byteLength(encodeUnknownJsonString(makeSubagent("")), "utf8");
      const promptLen = THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES - emptyLen - 40;
      yield* projectionStore.apply({
        id: EventId.make("event:merge-preview-cap:subagent-2"),
        type: "subagent.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: makeSubagent("x".repeat(promptLen)),
      });

      const rows = yield* sql<{
        readonly boundedJson: string | null;
        readonly payloadJson: string;
      }>`
        SELECT bounded_json AS "boundedJson", payload_json AS "payloadJson"
        FROM orchestration_v2_projection_subagents
        WHERE subagent_id = ${subagentId}
      `;
      const row = rows[0];
      assert.isDefined(row);
      if (row!.boundedJson !== null) {
        assert.isAtMost(
          Buffer.byteLength(row!.boundedJson, "utf8"),
          THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES,
        );
      }
      // The raw payload still carries the merged member.
      assert.match(row!.payloadJson, /"completionDelivery"/);

      // A third update omitting the field merges against a preview that
      // dropped it. The graft must come from the raw payload — re-grafting the
      // preview's missing member would store a schema-invalid JSON null.
      yield* projectionStore.apply({
        id: EventId.make("event:merge-preview-cap:subagent-3"),
        type: "subagent.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: makeSubagent("small"),
      });
      const thirdRows = yield* sql<{
        readonly boundedJson: string | null;
        readonly payloadJson: string;
      }>`
        SELECT bounded_json AS "boundedJson", payload_json AS "payloadJson"
        FROM orchestration_v2_projection_subagents
        WHERE subagent_id = ${subagentId}
      `;
      const thirdRow = thirdRows[0];
      assert.isDefined(thirdRow);
      assert.notMatch(thirdRow!.boundedJson ?? "", /"completionDelivery"\s*:\s*null/);
      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      assert.strictEqual(windowed.projection.subagents[0]?.completionDelivery?.state, "pending");
    }),
  );

  it.effect(
    "bounds completed nodes within one long run while preserving ancestry and live work",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:bounded-node-history");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:bounded-node-history"),
            title: "Bounded SQL history",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
        const runId = RunId.make("run:bounded-node-history");
        const rootNodeId = NodeId.make("node:bounded-node-history:root");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:run"),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:bounded-node-history"),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        const parentNodeId = NodeId.make("node:bounded-node-history:parent");
        const liveNodeId = NodeId.make("node:bounded-node-history:live");
        for (let index = -3; index < 1000; index++) {
          const id =
            index === -3
              ? rootNodeId
              : index === -2
                ? parentNodeId
                : index === -1
                  ? liveNodeId
                  : NodeId.make(`node:bounded-node-history:${index}`);
          yield* projectionStore.apply({
            id: EventId.make(`event:bounded-node-history:node:${index}`),
            type: "node.updated",
            threadId,
            runId,
            nodeId: id,
            driver,
            occurredAt: now,
            payload: {
              id,
              threadId,
              runId,
              rootNodeId,
              parentNodeId: index === -3 ? null : index === -2 ? rootNodeId : parentNodeId,
              kind: index === -3 ? "root_turn" : "assistant_message",
              status: index === -1 ? "running" : "completed",
              countsForRun: index === -3,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: index === -1 ? null : now,
            },
          });
          if (index < 0) continue;
          yield* projectionStore.apply({
            id: EventId.make(`event:bounded-node-history:item:${index}`),
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId: id,
            driver,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:bounded-node-history:${index}`),
              threadId,
              runId,
              nodeId: id,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: index,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "command_execution",
              input: `echo ${index}`,
              output: "ok",
              exitCode: 0,
            },
          });
        }
        const requestNodeId = NodeId.make("node:bounded-node-history:0");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:request"),
          type: "runtime-request.updated",
          threadId,
          runId,
          nodeId: requestNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:bounded-node-history"),
            nodeId: requestNodeId,
            providerTurnId: ProviderTurnId.make("provider-turn:bounded-node-history"),
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("session:bounded-node-history"),
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 75 });
        assert.lengthOf(snapshot.projection.visibleTurnItems, 75);
        assert.lengthOf(snapshot.projection.nodes, 79);
        const retained = new Set(snapshot.projection.nodes.map((node) => node.id));
        assert.isTrue(retained.has(rootNodeId));
        assert.isTrue(retained.has(parentNodeId));
        assert.isTrue(retained.has(liveNodeId));
        assert.isTrue(retained.has(requestNodeId));
        assert.lengthOf(snapshot.projection.runtimeRequests, 1);
        assert.isFalse(retained.has(NodeId.make("node:bounded-node-history:1")));
        for (const row of snapshot.projection.visibleTurnItems)
          assert.isTrue(retained.has(row.item.nodeId!));
        const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 75,
          anchorItemId: TurnItemId.make("item:bounded-node-history:925"),
        });
        assert.lengthOf(older.projection.nodes, 79);
        assert.isTrue(
          older.projection.nodes.some(
            (node) => node.id === NodeId.make("node:bounded-node-history:851"),
          ),
        );
        const full = yield* projectionStore.getThreadSnapshot(threadId);
        assert.lengthOf(full.projection.nodes, 1003);
      }),
  );

  it.effect("reads a fixed SQL turn-item window for long histories and repeated clients", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:bounded-sql-history");
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:bounded-sql-history"),
          title: "Bounded SQL history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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

      for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:${ordinal}`;
        const runId = `run:bounded-sql-history:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:bounded-sql-history:${ordinal}`,
              rootNodeId: `node:bounded-sql-history:${ordinal}`,
              activeAttemptId: null,
              status: "completed",
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `command ${ordinal}`,
              input: `echo ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const snapshots = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 76 }),
        ),
        { concurrency: 4 },
      );
      for (const snapshot of snapshots) {
        assert.lengthOf(snapshot.projection.turnItems, 76);
        assert.lengthOf(snapshot.projection.runs, 76);
        assert.lengthOf(snapshot.projection.visibleTurnItems, 76);
        assert.strictEqual(snapshot.projection.turnItems[0]?.ordinal, 925);
        assert.strictEqual(snapshot.projection.turnItems.at(-1)?.ordinal, 1_000);
      }
      const retainedRequestPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH selected AS (
          SELECT run_id, type
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC, turn_item_id DESC
          LIMIT 77
        )
        SELECT request.payload_json
        FROM orchestration_v2_projection_turn_items AS request
        WHERE request.run_id IN (
            SELECT run_id FROM selected
            WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
          )
          AND request.type = 'run_interrupt_request'
      `;
      assert.isTrue(
        retainedRequestPlan.some((row) =>
          row.detail.includes("orchestration_v2_projection_turn_items_run_ordinal_idx"),
        ),
      );

      const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 76,
        anchorItemId: TurnItemId.make("turn-item:bounded-sql-history:925"),
      });
      assert.lengthOf(older.projection.turnItems, 76);
      assert.lengthOf(older.projection.runs, 76);
      assert.strictEqual(older.projection.turnItems[0]?.ordinal, 850);
      assert.strictEqual(older.projection.turnItems.at(-1)?.ordinal, 925);

      const sqlPageLimit = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;
      const initialSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const initialPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: initialSnapshot.projection,
        snapshotSequence: initialSnapshot.snapshotSequence,
      });
      const loadedIds = initialPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let cursor = initialPage.historyCursor;
      let pageCount = 1;
      while (cursor !== null) {
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          ...anchorWindowOptions(cursor),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        loadedIds.push(...page.items.map((row) => String(row.sourceItemId)));
        pageCount += 1;
        cursor = page.nextCursor;
      }

      assert.isAtLeast(pageCount, 4);
      assert.lengthOf(loadedIds, 1_000);
      assert.strictEqual(new Set(loadedIds).size, 1_000);
      assert.deepEqual(
        loadedIds.toSorted(
          (left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1)),
        ),
        Array.from({ length: 1_000 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      const hiddenRunId = RunId.make("run:bounded-sql-history:hidden-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${hiddenRunId}, ${threadId}, 1001, 'codex', NULL, 'rolled_back', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: hiddenRunId,
            threadId,
            ordinal: 1001,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:hidden-suffix",
            rootNodeId: "node:bounded-sql-history:hidden-suffix",
            activeAttemptId: null,
            status: "rolled_back",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_001; ordinal <= 1_100; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:hidden:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${hiddenRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: hiddenRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "rolled back",
              input: "echo hidden",
              output: "hidden",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const hiddenSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const hiddenSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: hiddenSuffixSnapshot.projection,
        snapshotSequence: hiddenSuffixSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixPage.projection.visibleTurnItems, 75);
      assert.strictEqual(hiddenSuffixPage.latestLocalTurnOrdinal, 1_100);
      assert.isTrue(hiddenSuffixPage.hasMoreHistory);
      assert.isFalse(
        hiddenSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":hidden:"),
        ),
      );
      const hiddenSuffixCursor = hiddenSuffixPage.historyCursor;
      assert.isNotNull(hiddenSuffixCursor);
      const hiddenSuffixOlderSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        ...anchorWindowOptions(hiddenSuffixCursor!),
      });
      const hiddenSuffixOlderPage = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: hiddenSuffixOlderSnapshot.projection.visibleTurnItems,
        cursor: hiddenSuffixCursor!,
        snapshotSequence: hiddenSuffixOlderSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixOlderPage.items, 75);
      assert.isTrue(hiddenSuffixOlderPage.hasMoreHistory);

      const cancelledRunId = RunId.make("run:bounded-sql-history:cancelled-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${cancelledRunId}, ${threadId}, 1002, 'codex', NULL, 'cancelled', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: cancelledRunId,
            threadId,
            ordinal: 1002,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:cancelled-suffix",
            rootNodeId: "node:bounded-sql-history:cancelled-suffix",
            activeAttemptId: null,
            status: "cancelled",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_101; ordinal <= 1_200; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:cancelled:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'user_message', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              createdBy: "user",
              creationSource: "web",
              id,
              threadId,
              runId: cancelledRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "cancelled queued message",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "user_message",
              messageId: `message:bounded-sql-history:cancelled:${ordinal}`,
              inputIntent: "queued_turn",
              text: "cancelled",
              attachments: [],
            })}
          )
        `;
      }
      const runlessQueuedId = "turn-item:bounded-sql-history:runless-queued";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${runlessQueuedId}, ${threadId}, NULL, NULL, NULL, NULL, NULL, 1201,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: runlessQueuedId,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1201,
            status: "completed",
            title: "runless queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:runless-queued",
            inputIntent: "queued_turn",
            text: "still visible",
            attachments: [],
          })}
        )
      `;
      const laterCancelledId = "turn-item:bounded-sql-history:cancelled:1202";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${laterCancelledId}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, 1202,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: laterCancelledId,
            threadId,
            runId: cancelledRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1202,
            status: "completed",
            title: "later cancelled queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:cancelled:1202",
            inputIntent: "queued_turn",
            text: "cancelled",
            attachments: [],
          })}
        )
      `;
      const cancelledSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const cancelledSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: cancelledSuffixSnapshot.projection,
        snapshotSequence: cancelledSuffixSnapshot.snapshotSequence,
      });
      assert.strictEqual(cancelledSuffixPage.latestLocalTurnOrdinal, 1_202);
      assert.lengthOf(cancelledSuffixPage.projection.visibleTurnItems, 75);
      assert.isFalse(
        cancelledSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":cancelled:"),
        ),
      );
      assert.isTrue(
        cancelledSuffixPage.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === runlessQueuedId,
        ),
      );

      const interruptRunId = RunId.make("run:bounded-sql-history:interrupt");
      const interruptNodeId = NodeId.make("node:bounded-sql-history:interrupt");
      const interruptRequestId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-request");
      const interruptResultId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-result");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${interruptRunId}, ${threadId}, 1003, 'codex', 'provider-thread:interrupt', 'completed',
          ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: interruptRunId,
            threadId,
            ordinal: 1003,
            providerInstanceId,
            modelSelection,
            providerThreadId: "provider-thread:interrupt",
            userMessageId: "message:interrupt",
            rootNodeId: interruptNodeId,
            activeAttemptId: "attempt:bounded-sql-history:interrupt",
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:bounded-sql-history:interrupt', ${threadId}, ${interruptRunId}, 1,
          ${interruptNodeId}, 'codex', ${providerInstanceId}, 'provider-thread:interrupt', NULL,
          'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:bounded-sql-history:interrupt",
            runId: interruptRunId,
            attemptOrdinal: 1,
            rootNodeId: interruptNodeId,
            providerInstanceId,
            providerThreadId: "provider-thread:interrupt",
            providerTurnId: null,
            reason: "initial",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      const insertInterruptItem = (input: {
        id: TurnItemId;
        ordinal: number;
        type: "run_interrupt_request" | "run_interrupt_result";
      }) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${input.id}, ${threadId}, ${interruptRunId}, ${interruptNodeId}, NULL, NULL, NULL,
          ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: input.id,
            threadId,
            runId: interruptRunId,
            nodeId: interruptNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal,
            status: "completed",
            title: input.type,
            message: input.type === "run_interrupt_request" ? "Stopping" : "Stopped",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: input.type,
          })}
        )
      `;
      yield* insertInterruptItem({
        id: interruptRequestId,
        ordinal: 1_201,
        type: "run_interrupt_request",
      });
      for (let ordinal = 1_202; ordinal <= 1_281; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:interrupt-filler:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, NULL, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "filler",
              input: "echo filler",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      yield* insertInterruptItem({
        id: interruptResultId,
        ordinal: 1_282,
        type: "run_interrupt_result",
      });

      const interruptSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      assert.isTrue(
        interruptSnapshot.projection.turnItems.some((item) => item.id === interruptRequestId),
      );
      assert.isTrue(
        interruptSnapshot.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === interruptResultId,
        ),
      );
    }),
  );

  it.effect("scopes actionable provider state to the requested bounded thread", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:bounded-provider-scope");
      const targetThreadId = ThreadId.make("thread:bounded-provider-scope:target");
      const unrelatedThreadId = ThreadId.make("thread:bounded-provider-scope:unrelated");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: String(threadId),
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      for (const threadId of [targetThreadId, unrelatedThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:thread:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
        const sessionId = ProviderSessionId.make(`provider-session:${threadId}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:session:${threadId}`),
          type: "provider-session.attached",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId,
            status: "running",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:provider-thread:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
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
      }

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 10,
      });

      assert.deepEqual(
        snapshot.projection.providerSessions.map((session) => session.id),
        [ProviderSessionId.make(`provider-session:${targetThreadId}`)],
      );
      assert.deepEqual(
        snapshot.projection.providerThreads.map((thread) => thread.id),
        [ProviderThreadId.make(`provider-thread:${targetThreadId}`)],
      );
    }),
  );

  it.effect("projects root provider owners into the shell in first-use order", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:provider-history");
      const threadId = ThreadId.make("thread:provider-history");
      const claudeInstanceId = ProviderInstanceId.make("claude");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Provider history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
      const providerThreads = [
        // The root Codex conversation, then a Claude subagent it delegated to
        // (owned by a node, so not a handoff), then the handoff target.
        { suffix: "codex", instanceId: providerInstanceId, ownerNodeId: null, seconds: 0 },
        {
          suffix: "claude-subagent",
          instanceId: claudeInstanceId,
          ownerNodeId: NodeId.make("node:provider-history"),
          seconds: 1,
        },
        { suffix: "claude", instanceId: claudeInstanceId, ownerNodeId: null, seconds: 2 },
        // A second Codex conversation after handing back: no duplicate entry.
        { suffix: "codex-again", instanceId: providerInstanceId, ownerNodeId: null, seconds: 3 },
      ] as const;
      for (const providerThread of providerThreads) {
        const createdAt = DateTime.add(now, { seconds: providerThread.seconds });
        yield* projectionStore.apply({
          id: EventId.make(`event:provider-history:${providerThread.suffix}`),
          type: "provider-thread.updated",
          threadId,
          driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
          occurredAt: createdAt,
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-history:${providerThread.suffix}`),
            driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
            providerInstanceId: providerThread.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: providerThread.ownerNodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }

      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(shell?.providerInstanceHistory, [providerInstanceId, claudeInstanceId]);
    }),
  );

  it.effect("does not treat visited or marked-unread state as thread activity", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const visitedOccurredAt = DateTime.add(createdAt, { seconds: 1 });
      const markedUnreadOccurredAt = DateTime.add(createdAt, { seconds: 2 });
      const threadId = ThreadId.make("thread:projection-read-state");
      const projectId = ProjectId.make("project:projection-read-state");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Projection read state",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:visited"),
        type: "thread.visited",
        threadId,
        occurredAt: visitedOccurredAt,
        payload: { ...thread, lastVisitedAt: createdAt },
      });

      const visited = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(visited.thread.lastVisitedAt, createdAt);
      assert.deepEqual(visited.thread.updatedAt, createdAt);

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:marked-unread"),
        type: "thread.marked-unread",
        threadId,
        occurredAt: markedUnreadOccurredAt,
        payload: thread,
      });

      const markedUnread = yield* projectionStore.getThreadProjection(threadId);
      assert.isNull(markedUnread.thread.lastVisitedAt);
      assert.deepEqual(markedUnread.thread.updatedAt, createdAt);
    }),
  );

  it.effect("preserves delegated completion ownership across stale run and task updates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { seconds: 1 });
      const threadId = ThreadId.make("thread:projection-delegated-completion");
      const projectId = ProjectId.make("project:projection-delegated-completion");
      const runId = RunId.make("run:projection-delegated-completion");
      const rootNodeId = NodeId.make("node:projection-delegated-completion-root");
      const taskId = NodeId.make("node:projection-delegated-completion-task");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Delegated completion projection",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
      };
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-delegated-completion"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        delegatedCompletion: {
          disposition: "stopped" as const,
          nextGeneration: 2,
          delivery: null,
        },
      };
      const task = {
        id: taskId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Inspect the stop barrier.",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: {
          state: "disposed" as const,
          observedByRunId: null,
        },
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: task,
      });

      const { delegatedCompletion: _delegatedCompletion, ...staleRun } = run;
      const { completionDelivery: _completionDelivery, ...staleTask } = task;
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: later,
        payload: { ...staleRun, status: "interrupted", completedAt: later },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: later,
        payload: {
          ...staleTask,
          status: "interrupted",
          completedAt: later,
          updatedAt: later,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(projection.runs[0]?.delegatedCompletion, run.delegatedCompletion);
      assert.deepEqual(projection.subagents[0]?.completionDelivery, task.completionDelivery);
    }),
  );

  it.effect("only exposes interruptible runs through the shell activeRunId", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-shell-interruptible");
      const projectId = ProjectId.make("project:projection-shell-interruptible");
      const runId = RunId.make("run:projection-shell-interruptible");
      const rootNodeId = NodeId.make("node:projection-shell-interruptible");
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-shell-interruptible"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Interruptible shell run",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
        id: EventId.make("event:projection-shell-interruptible:running"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: run,
      });

      let shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "running");
      assert.equal(shell?.activeRunId, runId);
      assert.equal(
        shell?.latestRunRequestedAt && DateTime.toEpochMillis(shell.latestRunRequestedAt),
        DateTime.toEpochMillis(now),
      );
      assert.equal(
        shell?.latestRunStartedAt && DateTime.toEpochMillis(shell.latestRunStartedAt),
        DateTime.toEpochMillis(now),
      );
      assert.isNull(shell?.latestRunCompletedAt);

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:waiting"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: { ...run, status: "waiting" },
      });

      shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "waiting");
      assert.isNull(shell?.activeRunId);
      const later = DateTime.add(now, { hours: 1 });
      for (const status of ["queued", "cancelled"] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:clock:newer:${status}`),
          type: "run.updated",
          threadId,
          occurredAt: later,
          payload: {
            ...run,
            id: RunId.make("run:clock:newer"),
            ordinal: 2,
            status,
            requestedAt: later,
            startedAt: null,
            completedAt: status === "cancelled" ? later : null,
          },
        });
        for (const activityStatus of ["preparing", "running", "waiting", "completed"] as const) {
          yield* projectionStore.apply({
            id: EventId.make(`event:clock:${status}:${activityStatus}`),
            type: "run.updated",
            threadId,
            occurredAt: later,
            payload: {
              ...run,
              status: activityStatus,
              startedAt: activityStatus === "preparing" ? null : now,
              completedAt: activityStatus === "completed" ? later : null,
            },
          });
          const projection = yield* projectionStore.getThreadProjection(threadId);
          const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
            (row) => row.id === threadId,
          )!;
          const memoryShell = threadShellFromProjection(projection);
          const expected = activityStatus === "completed" ? null : DateTime.toEpochMillis(now);
          const timestamp = (value: DateTime.Utc | null | undefined) =>
            value == null ? null : DateTime.toEpochMillis(value);
          assert.equal(timestamp(sqlShell.activityRunStartedAt), expected);
          assert.equal(timestamp(memoryShell.activityRunStartedAt), expected);
          assert.equal(sqlShell.latestRunId, "run:clock:newer");
        }
      }
    }),
  );

  it.effect("selects only threads with runtime state that needs recovery", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const settledThreadId = ThreadId.make("thread:recovery-candidates:settled");
      const runningThreadId = ThreadId.make("thread:recovery-candidates:running");
      const rolledBackThreadId = yield* addRolledBackRecoveryCandidate("recovery-candidates");
      const orphanedThreadId = yield* addOrphanedRecoveryCandidate("recovery-candidates");
      const projectId = ProjectId.make("project:recovery-candidates");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Recovery candidate",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
      });

      for (const threadId of [settledThreadId, runningThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
      }

      const runId = RunId.make("run:recovery-candidates:running");
      const rootNodeId = NodeId.make("node:recovery-candidates:running");
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:run-created"),
        type: "run.created",
        threadId: runningThreadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: runningThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:recovery-candidates:running"),
          rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const recoveryThreadIds = yield* projectionStore.getRecoveryThreadIds("runtime");
      assert.include(recoveryThreadIds, runningThreadId);
      assert.include(recoveryThreadIds, orphanedThreadId);
      assert.notInclude(recoveryThreadIds, settledThreadId);
      assert.notInclude(recoveryThreadIds, rolledBackThreadId);
    }),
  );

  it.effect("projects only the latest failed root turn's limit into SQL and memory shells", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("limit-shell");
      const otherThreadId = yield* addRolledBackRecoveryCandidate("other-limit-shell");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const limitItem = {
        id: TurnItemId.make("limit-shell:error"),
        threadId,
        runId: original.id,
        nodeId: original.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed" as const,
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error" as const,
        failure: {
          class: "usage_limit" as const,
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        },
      };
      const applyRun = (status: typeof original.status, rootNodeId = original.rootNodeId) =>
        store.apply({
          id: EventId.make(`event:limit-shell:run:${status}:${rootNodeId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, rootNodeId, status },
        });
      const assertSummary = Effect.fnUntraced(function* (
        lastError: string | null,
        lastErrorClass: string | null,
      ) {
        const projection = yield* store.getThreadProjection(threadId);
        const memoryShell = threadShellFromProjection(projection);
        const shells = yield* store.getShellSnapshot();
        const sqlShell = shells.threads.find((row) => row.id === threadId)!;
        for (const shell of [memoryShell, sqlShell]) {
          assert.equal(shell.lastError, lastError);
          assert.equal(shell.lastErrorClass, lastErrorClass);
          assert.equal(
            shell.usageLimitResetAt,
            lastErrorClass === "usage_limit" ? "2099-01-01T00:00:00.000Z" : null,
          );
        }
        assert.isNull(shells.threads.find((row) => row.id === otherThreadId)!.lastErrorClass);
        const candidates = yield* store.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        });
        const candidate = candidates.find((row) => row.id === threadId);
        if (lastErrorClass === "usage_limit") {
          assert.deepEqual(candidate, {
            id: sqlShell.id,
            status: sqlShell.status,
            lastErrorClass: sqlShell.lastErrorClass,
            usageLimitResetAt: sqlShell.usageLimitResetAt,
            latestRunId: sqlShell.latestRunId,
            latestRunCompletedAt: sqlShell.latestRunCompletedAt,
            updatedAt: sqlShell.updatedAt,
            archivedAt: sqlShell.archivedAt,
            settledOverride: sqlShell.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: sqlShell.limitRecovery,
            snoozedUntil: sqlShell.snoozedUntil,
          });
        } else assert.isUndefined(candidate);
        assert.isUndefined(candidates.find((row) => row.id === otherThreadId));
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: limitItem,
      });
      yield* applyRun("failed");
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const sql = yield* SqlClient.SqlClient;
      const [originalRow] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      for (const [field, value] of [
        ["archivedAt", DateTime.formatIso(now)],
        ["settledOverride", "settled"],
      ]) {
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, ${`$.${field}`}, ${value})
          WHERE thread_id = ${threadId}`;
        assert.isUndefined(
          (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
            (row) => row.id === threadId,
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${DateTime.formatIso(now)} WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
      const recoveryOptions = { now, autoResume: false, snooze: false };
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates(recoveryOptions)).find(
          (row) => row.id === threadId,
        ),
      );
      const reset = DateTime.makeUnsafe(limitItem.failure.resetAt);
      const recovery = {
        runId: original.id,
        resetAt: limitItem.failure.resetAt,
        autoResume: true,
        requestId: CommandId.make("recovery:choice"),
      };
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.limitRecovery', json(${encodeUnknownJsonString(recovery)}))
        WHERE thread_id = ${threadId}`;
      // Armed future retries need no state decoding until they become due.
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, autoResume: true })).find(
          (row) => row.id === threadId,
        ),
      );
      const due = (yield* store.getLimitRecoveryCandidates({
        ...recoveryOptions,
        now: reset,
      })).find((row) => row.id === threadId)!;
      assert.deepEqual(due.limitRecovery, recovery);
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('limit-shell:pending-request', ${threadId}, ${original.rootNodeId}, 'approval', 'pending', ${DateTime.formatIso(now)}, '{}')`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = 'limit-shell:pending-request'`;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', ${DateTime.formatIso(DateTime.add(reset, { minutes: 1 }))})
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', NULL, '$.limitRecovery.autoResume', json('false'))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({
          ...recoveryOptions,
          now: reset,
          autoResume: true,
        })).find((row) => row.id === threadId),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      const session = {
        id: ProviderSessionId.make("session:limit-shell:shared"),
        driver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      for (const boundThreadId of [threadId, otherThreadId]) {
        yield* store.apply({
          id: EventId.make(`event:limit-shell:bind:${boundThreadId}`),
          type: "provider-session.attached",
          threadId: boundThreadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-failed"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: { ...session, status: "error", lastError: "Provider process exited." },
      });
      yield* assertSummary("Provider process exited.", null);
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-recovered"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: session,
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // A failed child is visible in history but does not replace the root's reason.
      yield* store.apply({
        id: EventId.make("event:limit-shell:child-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:child-error"),
          nodeId: NodeId.make("child-node"),
          ordinal: 3,
          failure: { ...limitItem.failure, class: "provider_error", message: "Child failed." },
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // A later ordinary root error replaces the limit classification.
      yield* store.apply({
        id: EventId.make("event:limit-shell:replacement"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:replacement"),
          ordinal: 4,
          failure: { ...limitItem.failure, class: "provider_error", message: "Provider failed." },
        },
      });
      yield* assertSummary("Provider failed.", "provider_error");
      for (const status of [
        "running",
        "completed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ] as const) {
        yield* applyRun(status);
        yield* assertSummary(null, null);
      }
      // A new attempt's root cannot inherit an earlier attempt's limit.
      yield* applyRun("failed", NodeId.make("new-attempt-root"));
      yield* assertSummary(null, null);
    }),
  );

  it.effect("projects one shared provider session into multiple thread bindings", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-shared-provider-session");
      const firstThreadId = ThreadId.make("thread:projection-shared-provider-session:first");
      const secondThreadId = ThreadId.make("thread:projection-shared-provider-session:second");
      const providerSessionId = ProviderSessionId.make(
        "provider-session:projection-shared-provider-session",
      );
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Shared provider session",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
      });
      const session = {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "error" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: "provider process exited",
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-thread"),
        type: "thread.created",
        threadId: firstThreadId,
        occurredAt: now,
        payload: makeThread(firstThreadId),
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:second-thread"),
        type: "thread.created",
        threadId: secondThreadId,
        occurredAt: now,
        payload: makeThread(secondThreadId),
      });
      for (const [threadId, suffix] of [
        [firstThreadId, "first"],
        [secondThreadId, "second"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shared-provider-session:${suffix}-binding`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }

      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getShellSnapshot()).threads
          .filter((thread) => thread.id === firstThreadId || thread.id === secondThreadId)
          .map((thread) => ({
            id: thread.id,
            lastError: thread.lastError,
          })),
        [
          { id: firstThreadId, lastError: "provider process exited" },
          { id: secondThreadId, lastError: "provider process exited" },
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-detached"),
        type: "provider-session.detached",
        threadId: firstThreadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: { providerSessionId, detachedAt: now },
      });

      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions,
        0,
      );
      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions,
        1,
      );
    }),
  );

  it.effect(
    "reads checkpoint context without decoding transcript or checkpoint file payloads",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:checkpoint-context");
        const runId = RunId.make("run:checkpoint-context");
        const nodeId = NodeId.make("node:checkpoint-context");
        const scopeId = CheckpointScopeId.make("scope:checkpoint-context");
        const checkpointId = CheckpointId.make("checkpoint:checkpoint-context");
        const ref = CheckpointRef.make("refs/t3/checkpoint-context/1");
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-context:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:checkpoint-context"),
            title: "Checkpoint context",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: "/repo/worktree",
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
          id: EventId.make("event:checkpoint-context:run"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:checkpoint-context"),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-context:scope"),
          type: "checkpoint-scope.created",
          threadId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId,
            nodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/repo/worktree",
            createdAt: now,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-context:checkpoint"),
          type: "checkpoint.captured",
          threadId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId,
            scopeId,
            runId,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref,
            status: "ready",
            files: [],
            capturedAt: now,
          },
        });
        // Old transcript shapes must not make a metadata-only diff unreadable.
        yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'turn-item:checkpoint-context:obsolete', ${threadId}, ${runId}, ${nodeId}, NULL, NULL,
          NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(now)},
          ${encodeUnknownJsonString({ obsolete: "transcript shape" })}
        )
      `;
        assert.strictEqual(
          (yield* Effect.exit(projectionStore.getThreadProjection(threadId)))._tag,
          "Failure",
        );
        yield* sql`
        UPDATE orchestration_v2_projection_checkpoints
        SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
        WHERE checkpoint_id = ${checkpointId}
      `;
        assert.deepEqual(yield* projectionStore.getCheckpointContext(threadId), {
          runs: [{ id: runId, ordinal: 1, status: "completed" }],
          checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd: "/repo/worktree" }],
          checkpoints: [
            {
              id: checkpointId,
              scopeId,
              runId,
              ordinalWithinScope: 1,
              appRunOrdinal: 1,
              status: "ready",
              ref,
            },
          ],
        });
        const missing = yield* projectionStore
          .getCheckpointContext(ThreadId.make("thread:checkpoint-context:missing"))
          .pipe(Effect.flip);
        assert.instanceOf(missing, ProjectionStoreThreadNotFoundError);
      }),
  );

  it.effect("keeps out-of-window checkpoints reachable through the legacy and context reads", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:checkpoint-window");
      const oldRunId = RunId.make("run:checkpoint-window:old");
      const newRunId = RunId.make("run:checkpoint-window:new");
      const oldNodeId = NodeId.make("node:checkpoint-window:old");
      const newNodeId = NodeId.make("node:checkpoint-window:new");
      const scopeId = CheckpointScopeId.make("scope:checkpoint-window:old");
      const checkpointId = CheckpointId.make("checkpoint:checkpoint-window:old");
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-window:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:checkpoint-window"),
          title: "Checkpoint window reachability",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
      for (const [runId, nodeId, ordinal] of [
        [oldRunId, oldNodeId, 1],
        [newRunId, newNodeId, 2],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-window:run:${ordinal}`),
          type: "run.created",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:checkpoint-window:${ordinal}`),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
      }
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-window:scope"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId: oldRunId,
          nodeId: oldNodeId,
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/worktree",
          createdAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-window:checkpoint"),
        type: "checkpoint.captured",
        threadId,
        occurredAt: now,
        payload: {
          id: checkpointId,
          threadId,
          scopeId,
          runId: oldRunId,
          nodeId: oldNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/checkpoint-window/1"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      });
      // One turn item on the old run, then a full window of newer rows on the
      // new run: the row cap drops the old item, which drops its run from the
      // hydration cohort and with it the checkpoint scope and checkpoint.
      for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
        const isOld = ordinal === 1;
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-window:item:${ordinal}`),
          type: "turn-item.updated",
          threadId,
          runId: isOld ? oldRunId : newRunId,
          nodeId: isOld ? oldNodeId : newNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:checkpoint-window:${ordinal}`),
            threadId,
            runId: isOld ? oldRunId : newRunId,
            nodeId: isOld ? oldNodeId : newNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "command_execution",
            input: `command ${ordinal}`,
            output: "ok",
            exitCode: 0,
          },
        });
      }

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 4,
      });
      assert.isTrue(windowed.hasOlderHistory);
      assert.isFalse(
        windowed.projection.turnItems.some(
          (item) => String(item.id) === "item:checkpoint-window:1",
        ),
      );
      assert.isFalse(windowed.projection.checkpointScopes.some((scope) => scope.id === scopeId));
      assert.isFalse(
        windowed.projection.checkpoints.some((checkpoint) => checkpoint.id === checkpointId),
      );

      // Clients that never opted into bounded snapshots take the unbounded
      // projection: every stored row and every rewind target stays visible.
      const full = yield* projectionStore.getThreadProjection(threadId);
      assert.isTrue(full.turnItems.some((item) => String(item.id) === "item:checkpoint-window:1"));
      assert.isTrue(full.checkpoints.some((checkpoint) => checkpoint.id === checkpointId));
      // Opted-in clients resolve out-of-window rewind targets through the
      // dedicated context read, which lists every checkpoint metadata row.
      const context = yield* projectionStore.getCheckpointContext(threadId);
      assert.isTrue(context.checkpoints.some((checkpoint) => checkpoint.id === checkpointId));
    }),
  );

  it.effect("builds shell snapshots without decoding full turn item payloads", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:projection-shell-stale-item");
      const projectId = ProjectId.make("project:projection-shell");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection shell",
          providerInstanceId,
          modelSelection: modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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

      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id,
          thread_id,
          run_id,
          node_id,
          provider_thread_id,
          provider_turn_id,
          parent_item_id,
          ordinal,
          type,
          status,
          updated_at,
          payload_json
        )
        VALUES (
          ${"turn-item:stale-user-message"},
          ${threadId},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${0},
          ${"user_message"},
          ${"completed"},
          ${nowIso},
          ${encodeUnknownJsonString({
            id: "turn-item:stale-user-message",
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:stale-user-message",
            text: "stale user message",
            attachments: [],
          })}
        )
      `;

      const shell = yield* projectionStore.getShellSnapshot();
      const fullProjectionExit = yield* Effect.exit(projectionStore.getThreadProjection(threadId));

      assert.deepEqual(
        shell.threads
          .filter((thread) => thread.id === threadId)
          .map((thread) => ({
            id: thread.id,
            itemCount: thread.itemCount,
            visibleItemCount: thread.visibleItemCount,
            status: thread.status,
          })),
        [
          {
            id: threadId,
            itemCount: 1,
            visibleItemCount: 1,
            status: "idle",
          },
        ],
      );
      assert.equal(fullProjectionExit._tag, "Failure");
    }),
  );

  it.effect("counts imported runless history inherited by fork shells", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-imported-fork-shell");
      const sourceThreadId = ThreadId.make("thread:projection-imported-fork-shell:source");
      const targetThreadId = ThreadId.make("thread:projection-imported-fork-shell:target");
      const sourceRunId = RunId.make("run:projection-imported-fork-shell:source");
      const rootNodeId = NodeId.make("node:projection-imported-fork-shell:source");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "system",
          creationSource: "server",
          id: sourceThreadId,
          projectId,
          title: "Imported fork source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
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
        id: EventId.make("event:projection-imported-fork-shell:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Imported fork target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRunId,
          },
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
        id: EventId.make("event:projection-imported-fork-shell:source-run"),
        type: "run.created",
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRunId,
          threadId: sourceThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-imported-fork-shell:run"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const applyAssistantItem = (suffix: string, runId: RunId | null, ordinal: number) =>
        projectionStore.apply({
          id: EventId.make(`event:projection-imported-fork-shell:item:${suffix}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          ...(runId === null ? {} : { runId }),
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-imported-fork-shell:${suffix}`),
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(`message:projection-imported-fork-shell:${suffix}`),
            text: suffix,
            streaming: false,
          },
        });

      yield* applyAssistantItem("imported-one", null, 1);
      yield* applyAssistantItem("imported-two", null, 2);
      yield* applyAssistantItem("native-run", sourceRunId, 3);

      const shell = yield* projectionStore.getShellSnapshot();
      const targetShell = shell.threads.find((thread) => thread.id === targetThreadId);
      const targetProjection = yield* projectionStore.getThreadProjection(targetThreadId);

      assert.isDefined(targetShell);
      assert.equal(targetShell.itemCount, 0);
      assert.equal(targetShell.visibleItemCount, 4);
      assert.equal(targetProjection.visibleTurnItems.length, 4);
    }),
  );

  it.effect("removes rolled back runs from the active visible projection", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
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

      // A rolled-back run's background item is abandoned, not pending. The
      // shell must not report it as Waiting, or the sidebar shows Waiting for
      // work nothing will ever finish.
      const shell = yield* projectionStore.getShellSnapshot();
      const rolledBackShellThread = shell.threads.find((entry) => entry.id === threadId);
      assert.isDefined(rolledBackShellThread);
      assert.isNull(rolledBackShellThread.latestVisibleMessage);
      assert.deepEqual(rolledBackShellThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("keeps fork visible items stable after a source run is rolled back", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-fork-source-rollback");
      const sourceThreadId = ThreadId.make("thread:projection-fork-source-rollback:source");
      const targetThreadId = ThreadId.make("thread:projection-fork-source-rollback:target");
      const sourceProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:source",
      );
      const targetProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:target",
      );
      const sourceRun1Id = RunId.make("run:projection-fork-source-rollback:source:1");
      const sourceRun2Id = RunId.make("run:projection-fork-source-rollback:source:2");
      const sourceRun3Id = RunId.make("run:projection-fork-source-rollback:source:3");
      const sourceRun1NodeId = NodeId.make("node:projection-fork-source-rollback:source:1");
      const sourceRun2NodeId = NodeId.make("node:projection-fork-source-rollback:source:2");
      const sourceRun3NodeId = NodeId.make("node:projection-fork-source-rollback:source:3");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: sourceThreadId,
          projectId,
          title: "Projection fork source rollback source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: sourceProviderThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
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
        id: EventId.make("event:projection-fork-source-rollback:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Projection fork source rollback target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: targetProviderThreadId,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRun2Id,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (const [ordinal, runId, nodeId, promptText, responseText] of [
        [1, sourceRun1Id, sourceRun1NodeId, "source one", "one"],
        [2, sourceRun2Id, sourceRun2NodeId, "source two", "two"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: sourceProviderThreadId,
            userMessageId: MessageId.make(
              `message:projection-fork-source-rollback:user:${ordinal}`,
            ),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:user-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:user:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make(`message:projection-fork-source-rollback:user:${ordinal}`),
            inputIntent: "turn_start",
            text: promptText,
            attachments: [],
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:assistant-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:assistant:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(
              `message:projection-fork-source-rollback:assistant:${ordinal}`,
            ),
            text: responseText,
            streaming: false,
          },
        });
      }

      const targetBeforeRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(
        targetBeforeRollback.visibleTurnItems.map((row) => row.item.type),
        ["user_message", "assistant_message", "user_message", "assistant_message", "fork"],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-2-rolled-back"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun2Id,
        nodeId: sourceRun2NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun2Id,
          threadId: sourceThreadId,
          ordinal: 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:2"),
          rootNodeId: sourceRun2NodeId,
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const targetAfterRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(
        targetAfterRollback.visibleTurnItems.map((row) => [
          row.visibility,
          row.item.type,
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.title,
        ]),
        [
          ["inherited", "user_message", "source one"],
          ["inherited", "assistant_message", "one"],
          ["inherited", "user_message", "source two"],
          ["inherited", "assistant_message", "two"],
          ["synthetic", "fork", "Forked from conversation"],
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-3"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun3Id,
        nodeId: sourceRun3NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun3Id,
          threadId: sourceThreadId,
          ordinal: 4,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:3"),
          rootNodeId: sourceRun3NodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const nowIso = DateTime.formatIso(now);
      for (let index = 0; index < 300; index += 1) {
        const id = `turn-item:projection-fork-source-rollback:post-fork:${index}`;
        const ordinal = index < 10 ? 190 + index : 300 + index;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun3Id}, ${sourceRun3NodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'command_execution',
            'completed', ${nowIso}, ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun3Id,
              nodeId: sourceRun3NodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "post fork",
              input: "echo later",
              output: "later",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const boundedFork = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.lengthOf(boundedFork.projection.turnItems, 0);
      assert.deepEqual(
        boundedFork.projection.visibleTurnItems.map((row) => [row.visibility, row.item.type]),
        [
          ["inherited", "user_message"],
          ["inherited", "assistant_message"],
          ["synthetic", "fork"],
        ],
      );
      const parentPage = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
        anchorItemId: TurnItemId.make("turn-item:projection-fork-source-rollback:assistant:1"),
      });
      assert.deepEqual(
        parentPage.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source one", "one", "fork"],
      );

      const emptyBoundaryRunId = RunId.make(
        "run:projection-fork-source-rollback:source:empty-boundary",
      );
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-boundary-run"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: emptyBoundaryRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyBoundaryRunId,
          threadId: sourceThreadId,
          ordinal: 3,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make(
            "message:projection-fork-source-rollback:user:empty-boundary",
          ),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const emptyBoundaryFork = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        emptyBoundaryFork.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source two", "two", "fork"],
      );
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${sourceRun2Id})
        WHERE thread_id = ${targetThreadId}
      `;

      const targetRunId = RunId.make("run:projection-fork-source-rollback:target:1");
      const targetNodeId = NodeId.make("node:projection-fork-source-rollback:target:1");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-run"),
        type: "run.updated",
        threadId: targetThreadId,
        runId: targetRunId,
        nodeId: targetNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: targetRunId,
          threadId: targetThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: targetProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:target:1"),
          rootNodeId: targetNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      for (let ordinal = 1; ordinal <= 102; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:target:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${targetThreadId}, ${targetRunId}, ${targetNodeId}, ${targetProviderThreadId},
            NULL, NULL, ${ordinal}, 'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: targetThreadId,
              runId: targetRunId,
              nodeId: targetNodeId,
              providerThreadId: targetProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `target ${ordinal}`,
              input: `echo target ${ordinal}`,
              output: "target",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const nestedThreadId = ThreadId.make("thread:projection-fork-source-rollback:nested");
      for (const ordinal of [
        ...Array.from({ length: 99 }, (_, index) => index + 1),
        ...Array.from({ length: 99 }, (_, index) => index + 101),
      ]) {
        const runId = ordinal < 100 ? sourceRun1Id : sourceRun2Id;
        const id = `turn-item:projection-fork-source-rollback:lineage:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `lineage ${ordinal}`,
              input: "echo lineage",
              output: "lineage",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const inheritedSupersededNodeId = NodeId.make(
        "node:projection-fork-source-rollback:inherited-superseded",
      );
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:projection-fork-source-rollback:inherited-superseded',
          ${sourceThreadId}, ${sourceRun2Id}, 2, ${inheritedSupersededNodeId}, 'codex',
          ${providerInstanceId}, ${sourceProviderThreadId}, NULL, 'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:projection-fork-source-rollback:inherited-superseded",
            runId: sourceRun2Id,
            attemptOrdinal: 2,
            rootNodeId: inheritedSupersededNodeId,
            providerInstanceId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            reason: "retry",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      for (let ordinal = 201; ordinal <= 300; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:hidden-interrupt:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun2Id}, ${inheritedSupersededNodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'run_interrupt_result',
            'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun2Id,
              nodeId: inheritedSupersededNodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "Stopped",
              message: "Stopped",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "run_interrupt_result",
            })}
          )
        `;
      }
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:nested-thread"),
        type: "thread.created",
        threadId: nestedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: nestedThreadId,
          projectId,
          title: "Nested bounded fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: targetThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: targetThreadId, runId: targetRunId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const boundedNested = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 2,
      });
      // The nearest ancestor segment is itself truncated by the row cap, so
      // deeper ancestry stays out of this window — cursors anchored on it
      // would strand the capped rows in between. Paging below reaches them.
      assert.deepEqual(
        boundedNested.projection.visibleTurnItems.map((row) => row.item.type),
        ["command_execution", "command_execution", "fork"],
      );
      assert.isTrue(boundedNested.hasOlderHistory);

      const nestedInitial = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: yield* projectionStore
          .getThreadSnapshotWindow(nestedThreadId, {
            rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          })
          .pipe(Effect.map((snapshot) => snapshot.projection)),
        snapshotSequence: 1,
      });
      const expectedNestedIds = (yield* projectionStore.getThreadProjection(
        nestedThreadId,
      )).visibleTurnItems.map((row) => String(row.sourceItemId));
      const nestedIds = nestedInitial.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let nestedCursor = nestedInitial.historyCursor;
      let nestedPages = 1;
      while (nestedCursor !== null) {
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          ...anchorWindowOptions(nestedCursor),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: snapshot.projection.visibleTurnItems,
          cursor: nestedCursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        nestedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        nestedCursor = page.nextCursor;
        nestedPages += 1;
      }
      assert.isAtLeast(nestedPages, 3);
      assert.lengthOf(nestedIds, expectedNestedIds.length);
      assert.deepEqual(nestedIds, expectedNestedIds);

      const nestedTurnWindow = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 77,
        userTurnLimit: 10,
      });
      const nestedTurnPage = buildBoundedThreadProjection({
        projection: nestedTurnWindow.projection,
        snapshotSequence: 1,
      });
      const turnPagedIds = nestedTurnPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let turnCursor = nestedTurnPage.historyCursor;
      while (turnCursor !== null) {
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          ...anchorWindowOptions(turnCursor),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor: turnCursor,
          snapshotSequence: 1,
        });
        turnPagedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        turnCursor = page.nextCursor;
      }
      assert.deepEqual(turnPagedIds, expectedNestedIds);

      const emptyMiddleThreadId = ThreadId.make(
        "thread:projection-fork-source-rollback:empty-middle",
      );
      const emptyMiddleRunId = RunId.make("run:projection-fork-source-rollback:empty-middle");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-thread"),
        type: "thread.created",
        threadId: emptyMiddleThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyMiddleThreadId,
          projectId,
          title: "Empty middle fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRun2Id },
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
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-run"),
        type: "run.updated",
        threadId: emptyMiddleThreadId,
        runId: emptyMiddleRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyMiddleRunId,
          threadId: emptyMiddleThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:empty-middle"),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const emptyLeafThreadId = ThreadId.make("thread:projection-fork-source-rollback:empty-leaf");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-leaf-thread"),
        type: "thread.created",
        threadId: emptyLeafThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyLeafThreadId,
          projectId,
          title: "Leaf after empty fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: emptyMiddleThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: emptyMiddleThreadId,
            runId: emptyMiddleRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const emptyMiddleSnapshot = yield* projectionStore.getThreadSnapshotWindow(
        emptyLeafThreadId,
        { rowLimit: 2 },
      );
      assert.deepEqual(
        emptyMiddleSnapshot.projection.visibleTurnItems.map((row) => [
          row.sourceThreadId,
          row.item.type,
        ]),
        [
          [sourceThreadId, "user_message"],
          [sourceThreadId, "assistant_message"],
          [sourceThreadId, "fork"],
          [emptyMiddleThreadId, "fork"],
        ],
      );

      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE run_id IN (${sourceRun1Id}, ${sourceRun2Id})
      `;
      const importedItemId = "turn-item:projection-fork-source-rollback:legacy-import";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${importedItemId}, ${sourceThreadId}, NULL, NULL, NULL, NULL, NULL, 50,
          'assistant_message', 'completed', ${nowIso}, ${encodeUnknownJsonString({
            id: importedItemId,
            threadId: sourceThreadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 50,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "assistant_message",
            messageId: MessageId.make("message:projection-fork-source-rollback:legacy-import"),
            text: "legacy import before empty fork",
            streaming: false,
            historyOrigin: "v1_import",
          })}
        )
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.historyOrigin', 'v1_import')
        WHERE thread_id = ${sourceThreadId}
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      // The local segment must not be truncated, otherwise older local rows
      // force ancestry out of the window entirely (see the nested fork case
      // above). 200 covers the 102 seeded local items plus the merge overhead.
      const importedEmptyBoundary = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 200,
      });
      assert.deepEqual(
        importedEmptyBoundary.projection.visibleTurnItems
          .slice(0, 2)
          .map((row) => [
            row.visibility,
            row.sourceThreadId,
            row.item.type === "assistant_message" ? row.item.text : row.item.type,
          ]),
        [
          ["inherited", sourceThreadId, "legacy import before empty fork"],
          ["synthetic", sourceThreadId, "fork"],
        ],
      );
      assert.lengthOf(importedEmptyBoundary.projection.visibleTurnItems, 104);
    }),
  );

  it.effect(
    "hydrates only referenced resolved requests plus all pending ones — no provider-turn fan-out",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const threadId = ThreadId.make("thread:bounded-request-cohort");
        const providerTurnId = ProviderTurnId.make("provider-turn:bounded-request-cohort");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-request-cohort:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:bounded-request-cohort"),
            title: "bounded request cohort",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
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
        const insertItem = (input: { id: string; ordinal: number; requestId?: string }) =>
          sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (
              ${input.id}, ${threadId}, NULL, NULL, NULL,
              ${input.requestId === undefined ? null : providerTurnId},
              NULL, ${input.ordinal},
              ${input.requestId === undefined ? "command_execution" : "user_input_request"},
              'completed', ${nowIso},
              ${encodeUnknownJsonString({
                id: input.id,
                threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: input.requestId === undefined ? null : providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: input.ordinal,
                status: "completed",
                title: null,
                startedAt: nowIso,
                completedAt: nowIso,
                updatedAt: nowIso,
                ...(input.requestId === undefined
                  ? {
                      type: "command_execution",
                      input: "cmd",
                      output: "ok",
                      exitCode: 0,
                    }
                  : {
                      type: "user_input_request",
                      requestId: input.requestId,
                      questions: [],
                    }),
              })}
            )
          `;
        for (let index = 1; index <= 79; index += 1) {
          yield* insertItem({
            id: `item:bounded-request-cohort:${index}`,
            ordinal: index,
          });
        }
        // The retained window covers high ordinals; this referencing item pulls
        // its request into the resolved cohort while its turn-mate stays out.
        yield* insertItem({
          id: "item:bounded-request-cohort:80",
          ordinal: 80,
          requestId: "request:bounded-request-cohort:kept",
        });
        const insertRequest = (input: {
          id: string;
          status: "pending" | "resolved";
          reason?: string;
        }) =>
          sql`
            INSERT INTO orchestration_v2_projection_runtime_requests (
              runtime_request_id, thread_id, node_id, provider_turn_id, kind,
              status, created_at, resolved_at, payload_json
            ) VALUES (
              ${input.id}, ${threadId}, 'node:bounded-request-cohort', ${providerTurnId}, 'command',
              ${input.status}, ${nowIso},
              ${input.status === "resolved" ? nowIso : null},
              ${encodeUnknownJsonString({
                id: input.id,
                nodeId: "node:bounded-request-cohort",
                providerTurnId,
                nativeRequestRef: null,
                kind: "command",
                status: input.status,
                responseCapability: {
                  type: "not_resumable",
                  reason: input.reason ?? "done",
                },
                createdAt: nowIso,
                resolvedAt: input.status === "resolved" ? nowIso : null,
              })}
            )
          `;
        // Same provider turn as the referenced request: under turn-fan-out
        // hydration both would land; only the referenced one must.
        yield* insertRequest({ id: "request:bounded-request-cohort:kept", status: "resolved" });
        yield* insertRequest({ id: "request:bounded-request-cohort:dropped", status: "resolved" });
        yield* insertRequest({ id: "request:bounded-request-cohort:pending", status: "pending" });

        const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 75,
        });
        const requestIds = windowed.projection.runtimeRequests
          .map((request) => String(request.id))
          .sort();
        assert.deepEqual(requestIds, [
          "request:bounded-request-cohort:kept",
          "request:bounded-request-cohort:pending",
        ]);
      }),
  );

  it.effect("caps aggregate resolved request bytes, keeping the newest referenced", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:bounded-request-bytes");
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-request-bytes:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:bounded-request-bytes"),
          title: "bounded request bytes",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
      const requestCount = 20;
      // 20 × ~70 KiB ≈ 1.4 MiB > the 1 MiB resolved-request budget.
      const reason = "r".repeat(70_000);
      for (let index = 0; index < requestCount; index += 1) {
        const requestId = `request:bounded-request-bytes:${index}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`item:bounded-request-bytes:${index}`}, ${threadId}, NULL, NULL, NULL, NULL,
            NULL, ${index + 1}, 'user_input_request', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id: `item:bounded-request-bytes:${index}`,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: index + 1,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "user_input_request",
              requestId,
              questions: [],
            })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runtime_requests (
            runtime_request_id, thread_id, node_id, provider_turn_id, kind,
            status, created_at, resolved_at, payload_json
          ) VALUES (
            ${requestId}, ${threadId}, 'node:bounded-request-bytes', NULL, 'command', 'resolved',
            ${`2026-09-13T00:00:${String(index).padStart(2, "0")}.000Z`}, ${nowIso},
            ${encodeUnknownJsonString({
              id: requestId,
              nodeId: "node:bounded-request-bytes",
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "resolved",
              responseCapability: { type: "not_resumable", reason },
              createdAt: `2026-09-13T00:00:${String(index).padStart(2, "0")}.000Z`,
              resolvedAt: nowIso,
            })}
          )
        `;
      }
      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      const hydrated = windowed.projection.runtimeRequests.map((request) => String(request.id));
      // The aggregate cap drops the oldest referenced requests first.
      assert.isBelow(hydrated.length, requestCount);
      assert.isAbove(hydrated.length, 0);
      const hydratedIndexes = hydrated.map((id) =>
        Number(id.slice("request:bounded-request-bytes:".length)),
      );
      assert.deepEqual(
        [...hydratedIndexes].sort((a, b) => a - b),
        hydratedIndexes,
      );
      for (const index of hydratedIndexes) {
        assert.isAbove(index, requestCount - 1 - hydrated.length);
      }
    }),
  );

  it.effect("retains a pending request's display item paged out of the window", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:pending-request-dep");
      yield* projectionStore.apply({
        id: EventId.make("event:pending-request-dep:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:pending-request-dep"),
          title: "pending request dep",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
      // Ordinal 1 pages out under a 75-row window; its pending request keeps it
      // in turnItems as a hidden dependency so pending questions still render.
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'item:pending-request-dep:question', ${threadId}, NULL, NULL, NULL, NULL,
          NULL, 1, 'user_input_request', 'pending', ${nowIso},
          ${encodeUnknownJsonString({
            id: "item:pending-request-dep:question",
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "pending",
            title: null,
            startedAt: nowIso,
            completedAt: null,
            updatedAt: nowIso,
            type: "user_input_request",
            requestId: "request:pending-request-dep",
            questions: [
              {
                header: "Pick",
                id: "q1",
                options: [
                  { label: "a", description: "first" },
                  { label: "b", description: "second" },
                ],
                question: "which?",
              },
            ],
          })}
        )
      `;
      for (let index = 2; index <= 80; index += 1) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`item:pending-request-dep:${index}`}, ${threadId}, NULL, NULL, NULL, NULL,
            NULL, ${index}, 'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id: `item:pending-request-dep:${index}`,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: index,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
              input: "cmd",
              output: "ok",
              exitCode: 0,
            })}
          )
        `;
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_runtime_requests (
          runtime_request_id, thread_id, node_id, provider_turn_id, kind,
          status, created_at, resolved_at, payload_json
        ) VALUES (
          'request:pending-request-dep', ${threadId}, 'node:pending-request-dep', NULL, 'user_input',
          'pending', ${nowIso}, NULL,
          ${encodeUnknownJsonString({
            id: "request:pending-request-dep",
            nodeId: "node:pending-request-dep",
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: nowIso,
            resolvedAt: null,
          })}
        )
      `;

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      // The request hydrates (pending is unconditional) and its display item
      // rides along as a hidden dependency — never as a pageable row.
      assert.isTrue(
        windowed.projection.runtimeRequests.some(
          (request) => request.id === "request:pending-request-dep",
        ),
      );
      const depItem = windowed.projection.turnItems.find(
        (item) => item.id === "item:pending-request-dep:question",
      );
      assert.isDefined(depItem);
      assert.isFalse(
        windowed.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === "item:pending-request-dep:question",
        ),
      );
    }),
  );

  it.effect("flags compacted items and serves the raw row through getThreadTurnItem", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:turn-item-recovery");
      const itemId = TurnItemId.make("item:turn-item-recovery:huge");
      const hugeText = "h".repeat(200_000);
      yield* projectionStore.apply({
        id: EventId.make("event:turn-item-recovery:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:turn-item-recovery"),
          title: "turn item recovery",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
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
        id: EventId.make("event:turn-item-recovery:item"),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: itemId,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make("message:turn-item-recovery"),
          text: hugeText,
          attachments: [],
          streaming: false,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:turn-item-recovery:small"),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:turn-item-recovery:small"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make("message:turn-item-recovery:small"),
          text: "small",
          attachments: [],
          streaming: false,
        },
      });

      const windowed = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 75,
      });
      const compacted = windowed.projection.turnItems.find((item) => item.id === itemId);
      assert.isDefined(compacted);
      assert.strictEqual(compacted?.payloadTruncated, true);
      assert.isTrue(
        compacted?.type === "assistant_message" && compacted.text.length < hugeText.length,
      );
      const small = windowed.projection.turnItems.find(
        (item) => item.id === TurnItemId.make("item:turn-item-recovery:small"),
      );
      assert.isUndefined(small?.payloadTruncated);

      // The raw row is reachable by id and carries the full content unflagged.
      const raw = yield* projectionStore.getThreadTurnItem(threadId, itemId);
      assert.isTrue(raw?.type === "assistant_message" && raw.text === hugeText);
      assert.isUndefined(raw?.payloadTruncated);
      const missing = yield* projectionStore.getThreadTurnItem(
        threadId,
        TurnItemId.make("item:turn-item-recovery:absent"),
      );
      assert.isNull(missing);
    }),
  );
});

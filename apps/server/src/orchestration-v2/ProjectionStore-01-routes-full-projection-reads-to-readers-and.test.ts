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
  assertShellIndexCoversShells,
  addRolledBackRecoveryCandidate,
} from "./ProjectionStore-fixtures.testkit.ts";

it.effect("routes full projection reads to readers and retains uncommitted writer state", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parentId = yield* addRolledBackRecoveryCandidate("reader-routing");
    const parent = yield* store.getThreadProjection(parentId);
    const threadId = ThreadId.make("thread:reader-routing:fork");
    yield* store.apply({
      id: EventId.make("event:reader-routing:fork"),
      type: "thread.created",
      threadId,
      occurredAt: parent.thread.createdAt,
      payload: {
        ...parent.thread,
        id: threadId,
        forkedFrom: { type: "run", threadId: parentId, runId: parent.runs[0]!.id },
      },
    });
    const { queries, trace } = traceSqlRouting();
    const projection = yield* store.getThreadProjection(threadId).pipe(trace);
    assert.equal(projection.thread.id, threadId);
    assert.deepEqual(
      projection.visibleTurnItems
        .filter((row) => row.visibility === "inherited")
        .map((row) => row.sourceItemId),
      parent.turnItems.map((item) => item.id),
    );
    assert.isAbove(queries.length, 1);
    assert.deepEqual([...new Set(queries.map((row) => row.connection))], ["reader"]);
    const commitRequested = yield* Deferred.make<void>();
    const writer = yield* Deferred.await(commitRequested).pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, '$.title', 'Committed title')
          WHERE thread_id = ${threadId}
        `;
            yield* sql`
          UPDATE orchestration_v2_projection_turn_items
          SET payload_json = json_set(payload_json, '$.title', 'Committed command')
          WHERE thread_id = ${parentId}
        `;
          }),
        ),
      ),
      Effect.forkChild,
    );
    let commitInjected = false;
    const duringCommit = yield* store.getThreadProjection(threadId).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        const [query] = statement.compile();
        if (!commitInjected && query.includes("FROM orchestration_v2_projection_turn_items")) {
          commitInjected = true;
          return Deferred.succeed(commitRequested, undefined).pipe(
            Effect.andThen(Fiber.join(writer).pipe(Effect.orDie)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      }),
    );
    assert.isTrue(commitInjected);
    assert.deepEqual(duringCommit, projection);
    const afterCommit = yield* store.getThreadProjection(threadId);
    assert.equal(afterCommit.thread.title, "Committed title");
    assert.equal(
      afterCommit.visibleTurnItems.find((row) => row.visibility === "inherited")?.item.title,
      "Committed command",
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.title', 'Uncommitted title')
        WHERE thread_id = ${threadId}
      `;
        assert.equal(
          (yield* store.getThreadProjection(threadId)).thread.title,
          "Uncommitted title",
        );
      }),
    );
  }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(layerReaderDatabase)))),
);
it.effect("record reads restrict provider histories to delivery identities", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("delivery-identities");
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (const suffix of ["selected", "history"]) {
      const id = ProviderThreadId.make(`provider-thread:${suffix}`);
      yield* store.apply({
        id: EventId.make(`event:delivery-identities:${suffix}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id,
          appThreadId: threadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          status: "active",
          firstRunOrdinal: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    for (const [suffix, attempt] of [
      ["selected", "current"],
      ["history", "old"],
      ["runless", null],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:delivery-turn:${suffix}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`turn:${suffix}`),
          providerThreadId: ProviderThreadId.make("provider-thread:selected"),
          nodeId: NodeId.make("node:delivery"),
          runAttemptId: attempt === null ? null : RunAttemptId.make(attempt),
          nativeTurnRef: null,
          ordinal: suffix === "selected" ? 1 : suffix === "history" ? 2 : 3,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [RunAttemptId.make("current")],
      })).providerTurns.map((turn) => turn.id),
      ["turn:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [],
      })).providerTurns,
      [],
    );
    const selected = yield* store.getThreadRecords(threadId, ["providerThreads"], {
      providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
    });
    assert.deepEqual(
      selected.providerThreads.map((row) => row.id),
      ["provider-thread:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [],
      })).providerThreads,
      [],
    );
    // Unselected history must not be decoded, even if its payload is unreadable.
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'
      WHERE provider_thread_id = 'provider-thread:history'`;
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
      })).providerThreads,
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);
it.effect("idle compaction filters keep the latest run, live work and the newest usage", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    // Its rolled-back run 1 still has a running item, which background work must ignore.
    const threadId = yield* addRolledBackRecoveryCandidate("idle-compaction");
    const now = yield* DateTime.now;
    const minutes = (count: number) => DateTime.add(now, { minutes: count });
    const selected = ProviderThreadId.make("provider-thread:idle-selected");
    const nodeId = NodeId.make("node:idle-compaction");
    for (const [ordinal, status] of [
      [2, "completed"],
      [3, "completed"],
      [4, "failed"],
      // A removed or steered queued message.
      [5, "cancelled"],
    ] as const) {
      const runId = RunId.make(`run:idle-compaction:${ordinal}`);
      yield* store.apply({
        id: EventId.make(`event:idle-compaction:run-${ordinal}`),
        type: "run.created",
        threadId,
        runId,
        nodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId,
          modelSelection,
          providerThreadId: selected,
          userMessageId: MessageId.make(`message:idle-compaction:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status,
          requestedAt: now,
          startedAt: status === "cancelled" ? null : now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    }
    for (const [id, providerThreadId, ordinal, usageAt] of [
      ["turn:idle-old", selected, 1, minutes(1)],
      ["turn:idle-newest", selected, 2, minutes(3)],
      ["turn:idle-later-ordinal", selected, 3, minutes(2)],
      ["turn:idle-no-usage", selected, 4, null],
      [
        "turn:idle-other-thread",
        ProviderThreadId.make("provider-thread:idle-other"),
        1,
        minutes(9),
      ],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:${id}`),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(id),
          providerThreadId,
          nodeId,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
          ...(usageAt === null
            ? {}
            : { tokenUsage: { usedTokens: 150_000, updatedAt: DateTime.formatIso(usageAt) } }),
        },
      });
    }
    for (const status of ["pending", "resolved"] as const) {
      yield* store.apply({
        id: EventId.make(`event:idle-compaction:request-${status}`),
        type: "runtime-request.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(`request:idle-compaction:${status}`),
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status,
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: status === "pending" ? null : now,
        },
      });
    }
    for (const status of ["pending", "consumed"] as const) {
      yield* store.apply({
        id: EventId.make(`event:idle-compaction:transfer-${status}`),
        type: "context-transfer.created",
        threadId,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make(`transfer:idle-compaction:${status}`),
          type: "merge_back",
          sourceThreadId: ThreadId.make("thread:idle-compaction:side"),
          targetThreadId: threadId,
          sourcePoint: { threadId: ThreadId.make("thread:idle-compaction:side") },
          basePoint: null,
          sourceProviderInstanceId: providerInstanceId,
          targetProviderInstanceId: providerInstanceId,
          targetRunId: null,
          status,
          resolution: null,
          createdBy: "user",
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: status === "pending" ? null : now,
        },
      });
    }

    const records = yield* store.getThreadRecords(
      threadId,
      ["runs", "providerTurns", "runtimeRequests", "contextTransfers"],
      {
        runStatuses: ["preparing", "starting", "running", "rolled_back"],
        includeLatestRun: true,
        providerTurnThreadIds: [selected],
        latestProviderTurnUsageOnly: true,
        runtimeRequestStatuses: ["pending"],
        contextTransferStatuses: ["pending"],
      },
    );
    // The failed latest run stays, so a completed earlier run is not mistaken for the latest,
    // and a cancelled queued run never counts as the latest.
    assert.deepEqual(
      records.runs.map((run) => run.id),
      ["run:idle-compaction:rolled-back", "run:idle-compaction:4"],
    );
    assert.deepEqual(
      records.providerTurns.map((turn) => turn.id),
      ["turn:idle-newest"],
    );
    assert.deepEqual(
      records.runtimeRequests.map((request) => request.id),
      ["request:idle-compaction:pending"],
    );
    assert.deepEqual(
      records.contextTransfers.map((transfer) => transfer.id),
      ["transfer:idle-compaction:pending"],
    );
    const empty = yield* store.getThreadRecords(threadId, ["runs", "providerTurns"], {
      runStatuses: [],
      providerTurnThreadIds: [],
      latestProviderTurnUsageOnly: true,
    });
    assert.deepEqual([empty.runs, empty.providerTurns], [[], []]);
  }).pipe(Effect.provide(layerTest)),
);
it.effect("record reads filter notification sources without dropping matching message bodies", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("notification-filter");
    const now = yield* DateTime.now;
    for (const [id, role, kind] of [
      ["ordinary", "user", null],
      ["monitor", "user", "monitor"],
      ["system", "user", "system"],
      ["assistant-monitor", "assistant", "monitor"],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`notification-filter:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: MessageId.make(id),
          threadId,
          runId: null,
          nodeId: null,
          createdBy: "agent",
          creationSource: "server",
          role,
          text: `Complete body for ${id}`,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          ...(kind === null
            ? {}
            : {
                notification: {
                  source: { kind },
                  outcome: "updated",
                  summary: "Background notification",
                },
              }),
        },
      });
    }
    const matching = yield* store.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
      monitorNotificationsOnly: true,
    });
    assert.deepEqual(
      matching.messages.map((message) => [message.id, message.text]),
      [["monitor", "Complete body for monitor"]],
    );
    assert.lengthOf((yield* store.getThreadRecords(threadId, ["messages"])).messages, 4);
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["messages"], {
        monitorNotificationsOnly: true,
      })).messages,
      2,
    );
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["messages"], {
        monitorNotificationsOnly: false,
      })).messages,
      4,
    );
  }).pipe(Effect.provide(layerTest)),
);
it.effect("SQL queue readiness skips held runs without bypassing active work", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("held-queue");
    const { runs } = yield* store.getThreadProjection(threadId);
    const run = runs[0]!;
    const now = yield* DateTime.now;
    const held = { ...run, status: "queued" as const, queueHeld: true };
    yield* store.apply({
      id: EventId.make("held-queue:held"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: held,
    });
    assert.isFalse(yield* store.canStartQueuedRun(threadId));

    const wake = { ...run, id: RunId.make("held-queue:wake"), ordinal: 2 };
    for (const status of ["running", "queued", "completed"] as const) {
      yield* store.apply({
        id: EventId.make(`held-queue:wake:${status}`),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...wake, status },
      });
      assert.equal(yield* store.canStartQueuedRun(threadId), status === "queued");
    }
    assert.deepEqual((yield* store.getThreadProjection(threadId)).runs[0], held);
  }).pipe(Effect.provide(layerTest)),
);
it.effect("SQL shells flag only an active turn blocked solely on T3 thread waits", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("thread-wait");
    const initial = yield* store.getThreadProjection(threadId);
    const at = initial.updatedAt;
    const previousCommand = initial.turnItems.find((item) => item.type === "command_execution")!;
    const itemBase = {
      ...previousCommand,
      providerThreadId: previousCommand.providerThreadId ?? null,
      providerTurnId: previousCommand.providerTurnId ?? null,
      nativeItemRef: previousCommand.nativeItemRef ?? null,
      parentItemId: previousCommand.parentItemId ?? null,
    };
    yield* store.apply({
      id: EventId.make("event:thread-wait:previous-completed"),
      type: "run.updated",
      threadId,
      occurredAt: at,
      payload: { ...initial.runs[0]!, status: "completed", completedAt: at },
    });
    const run = {
      ...initial.runs[0]!,
      id: RunId.make("run:thread-wait:active"),
      ordinal: 2,
      status: "running" as const,
      completedAt: null,
    };
    yield* store.apply({
      id: EventId.make("event:thread-wait:active"),
      type: "run.created",
      threadId,
      occurredAt: at,
      payload: run,
    });
    let sequence = 0;
    const updateItem = (payload: OrchestrationV2TurnItem) =>
      store.apply({
        id: EventId.make(`event:thread-wait:item:${sequence++}`),
        type: "turn-item.updated",
        threadId,
        runId: payload.runId ?? undefined,
        driver,
        occurredAt: at,
        payload,
      });
    const assertBlocked = Effect.fnUntraced(function* (expected: boolean) {
      const listed = (yield* store.getShellSnapshot()).threads.find((row) => row.id === threadId);
      for (const shell of [yield* store.getThreadShell(threadId), listed]) {
        assert.equal(shell?.activeRunId, run.id);
        assert.equal(shell?.status, "running");
        assert.equal(shell?.blockedOnThreadWait ?? false, expected);
      }
      yield* assertShellIndexCoversShells();
    });
    const wait = {
      ...itemBase,
      id: TurnItemId.make("item:thread-wait:active"),
      runId: run.id,
      type: "dynamic_tool" as const,
      toolName: "mcp__t3_code__t3_thread_wait",
      input: { threadId: "child-thread" },
      status: "running" as const,
    };

    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:stale"),
      runId: initial.runs[0]!.id,
    });
    yield* assertBlocked(false);
    const foreign = {
      ...wait,
      id: TurnItemId.make("item:thread-wait:foreign"),
      toolName: "weather.t3_thread_wait",
    };
    yield* updateItem(foreign);
    yield* assertBlocked(false);
    yield* updateItem({ ...foreign, status: "completed", completedAt: at });
    yield* updateItem({ ...wait, status: "pending", startedAt: null });
    yield* assertBlocked(false);
    yield* updateItem(wait);
    yield* assertBlocked(true);

    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:plan"),
      type: "todo_list",
      planId: PlanId.make("plan:thread-wait"),
      steps: [{ id: "review", text: "Review the child result", status: "running" }],
    });
    yield* assertBlocked(true);
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:proposed-plan"),
      type: "proposed_plan",
      planId: PlanId.make("plan:thread-wait:proposed"),
      markdown: "Review the child result",
      streaming: true,
    });
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:named-message"),
      nativeItemRef: { driver, nativeId: "named-message", strength: "weak" },
      type: "assistant_message",
      messageId: MessageId.make("message:thread-wait:named"),
      text: "Waiting for the child result",
      streaming: true,
    });
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:named-thought"),
      nativeItemRef: { driver, nativeId: "named-thought", strength: "weak" },
      type: "reasoning",
      text: "I need the child result",
      streaming: true,
    });
    yield* assertBlocked(true);

    const command = {
      ...itemBase,
      id: TurnItemId.make("item:thread-wait:concurrent"),
      runId: run.id,
    };
    yield* updateItem(command);
    yield* assertBlocked(false);
    yield* updateItem({ ...wait, status: "waiting" });
    yield* assertBlocked(false);
    yield* updateItem({ ...command, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    const fileChange = {
      ...command,
      id: TurnItemId.make("item:thread-wait:concurrent-edit"),
      type: "file_change" as const,
      fileName: "example.ts",
    };
    yield* updateItem(fileChange);
    yield* assertBlocked(false);
    yield* updateItem({ ...fileChange, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    const compaction = {
      ...command,
      id: TurnItemId.make("item:thread-wait:compaction"),
      type: "compaction" as const,
      driver,
    };
    yield* updateItem(compaction);
    yield* assertBlocked(false);
    yield* updateItem({ ...compaction, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    yield* updateItem({ ...wait, status: "completed", completedAt: at });
    yield* assertBlocked(false);

    const delegation = {
      ...wait,
      id: TurnItemId.make("item:thread-wait:delegation"),
      toolName: "t3-code-thread_opencode2-adapter_delegate_task",
      input: { task: "Review", mode: "async" },
    };
    yield* updateItem(delegation);
    yield* assertBlocked(false);
    yield* updateItem({ ...delegation, status: "completed", completedAt: at });
    const blockingDelegation = {
      ...delegation,
      id: TurnItemId.make("item:thread-wait:blocking-delegation"),
      input: { task: "Review", mode: "wait" },
    };
    yield* updateItem({
      ...command,
      id: TurnItemId.make("item:thread-wait:child"),
      type: "subagent",
      subagentId: NodeId.make("node:thread-wait:child"),
      origin: "app_owned",
      driver,
      providerInstanceId,
      childThreadId: ThreadId.make("child-thread"),
      prompt: "Review",
      result: null,
    });
    yield* updateItem(blockingDelegation);
    yield* assertBlocked(true);
    yield* updateItem({ ...blockingDelegation, status: "completed", completedAt: at });
    yield* assertBlocked(false);
  }).pipe(Effect.provide(layerTest)),
);

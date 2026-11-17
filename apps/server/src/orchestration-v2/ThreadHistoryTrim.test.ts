import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadHistoryTrim from "./ThreadHistoryTrim.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provideMerge(database)),
  ProjectionStore.layer.pipe(Layer.provideMerge(database)),
);
const dependencies = (afterDays: number) =>
  Layer.mergeAll(
    stores,
    OrchestrationEventStore.layer.pipe(Layer.provide(database)),
    EventSink.layer.pipe(Layer.provide(stores)),
    IdAllocator.layer,
    ServerSettings.ServerSettingsService.layerTest({ threadHistoryTrimAfterDays: afterDays }),
  );
const layerTest = (afterDays: number) =>
  ThreadHistoryTrim.layer.pipe(Layer.provideMerge(dependencies(afterDays)));

const now = DateTime.makeUnsafe("2026-11-17T00:00:00.000Z");
const old = DateTime.subtract(now, { days: 40 });
const recent = DateTime.subtract(now, { days: 3 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

type SeedOptions = {
  readonly thread?: Partial<OrchestrationV2AppThread>;
  readonly runStatus?: OrchestrationV2Run["status"];
  readonly userMessageAt?: DateTime.Utc;
};

const seedThread = Effect.fn(function* (name: string, options: SeedOptions = {}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const threadId = ThreadId.make(`thread:trim:${name}`);
  const runId = RunId.make(`run:${threadId}:1`);
  const runStatus = options.runStatus ?? "completed";
  const userMessageAt = options.userMessageAt ?? old;
  const rootNodeId = NodeId.make(`node:${name}:root`);
  const commandNodeId = NodeId.make(`node:${name}:command`);
  const editNodeId = NodeId.make(`node:${name}:edit`);
  const userMessageId = MessageId.make(`message:${name}:user`);
  const assistantMessageId = MessageId.make(`message:${name}:assistant`);
  let sequence = 0;
  const event = <Event extends OrchestrationV2DomainEvent>(
    input: Omit<Event, "id" | "threadId" | "occurredAt">,
  ) =>
    ({
      id: EventId.make(`event:${name}:${sequence++}`),
      threadId,
      occurredAt: old,
      ...input,
    }) as OrchestrationV2DomainEvent;
  const node = (id: NodeId, kind: "root_turn" | "tool_call", parentNodeId: NodeId | null) =>
    event({
      type: "node.updated",
      runId,
      nodeId: id,
      payload: {
        id,
        threadId,
        runId,
        rootNodeId,
        parentNodeId,
        kind,
        status: runStatus === "completed" ? "completed" : "running",
        countsForRun: kind === "root_turn",
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: old,
        completedAt: runStatus === "completed" ? old : null,
      },
    });
  const itemBase = (key: string, nodeId: NodeId | null = null, parent: string | null = null) => ({
    id: TurnItemId.make(`item:${name}:${key}`),
    threadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: parent === null ? null : TurnItemId.make(`item:${name}:${parent}`),
    ordinal: 0,
    status: "completed" as const,
    title: key,
    startedAt: old,
    completedAt: old,
    updatedAt: old,
  });
  const item = (payload: OrchestrationV2TurnItem) =>
    event({ type: "turn-item.updated", runId, payload });
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:trim"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...options.thread,
  };
  yield* eventSink.write({
    events: [
      event({ type: "thread.created", payload: thread }),
      event({
        type: "run.created",
        runId,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId,
          rootNodeId,
          activeAttemptId: null,
          status: runStatus,
          requestedAt: old,
          startedAt: old,
          completedAt: runStatus === "completed" ? old : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      }),
      node(rootNodeId, "root_turn", null),
      node(commandNodeId, "tool_call", rootNodeId),
      node(editNodeId, "tool_call", rootNodeId),
      event({
        type: "message.updated",
        runId,
        payload: {
          id: userMessageId,
          threadId,
          runId,
          nodeId: null,
          role: "user",
          text: `please fix the flaky ${name} harness`,
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: userMessageAt,
          updatedAt: userMessageAt,
        },
      }),
      item({
        ...itemBase("user"),
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId: userMessageId,
        inputIntent: "turn_start",
        text: `please fix the flaky ${name} harness`,
        attachments: [],
      }),
      item({ ...itemBase("reasoning"), type: "reasoning", text: "thinking", streaming: false }),
      item({
        ...itemBase("command", commandNodeId),
        type: "command_execution",
        input: "vp test",
        output: "x".repeat(4_000),
      }),
      item({
        ...itemBase("tool"),
        type: "dynamic_tool",
        toolName: "Edit",
        input: null,
        output: "y".repeat(4_000),
      }),
      item({
        ...itemBase("edit", editNodeId, "tool"),
        type: "file_change",
        fileName: "harness.ts",
      }),
      item({
        ...itemBase("sent"),
        type: "dynamic_tool",
        toolName: "mcp__t3-code__send_to_user",
        input: null,
        output: "The draft the user was asked to read.",
      }),
      item({
        ...itemBase("assistant"),
        type: "assistant_message",
        messageId: assistantMessageId,
        text: "Fixed the harness.",
        streaming: false,
      }),
    ],
  });
  return { threadId, runId };
});

const itemTitles = Effect.fn(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly title: string }>`
    SELECT json_extract(payload_json, '$.title') AS title
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId}
    ORDER BY ordinal ASC
  `;
  return rows.map((row) => row.title);
});

const everyItem = ["user", "reasoning", "command", "tool", "edit", "sent", "assistant"];
// `sent` stays: the timeline always shows that output inline.
const trimmedItems = ["user", "tool", "edit", "sent", "assistant", "Older detail was trimmed"];

const trim = Effect.gen(function* () {
  const service = yield* ThreadHistoryTrim.ThreadHistoryTrim;
  const report = yield* service.trimNow;
  yield* service.drain;
  return report;
});

it.layer(layerTest(30))("ThreadHistoryTrim", (it) => {
  it.effect("drops tool output and reasoning, and keeps what reading and resuming use", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ThreadHistoryTrim.ThreadHistoryTrim;
      const { threadId } = yield* seedThread("idle");

      const preview = yield* service.preview;
      assert.deepEqual(
        { dryRun: preview.dryRun, threadCount: preview.threadCount, itemCount: preview.itemCount },
        { dryRun: true, threadCount: 1, itemCount: 3 },
      );
      assert.isAbove(preview.estimatedBytes, 8_000);
      assert.deepEqual(yield* itemTitles(threadId), everyItem);

      const report = yield* trim;
      assert.equal(report.dryRun, false);
      // `tool` stays: the kept file change hangs off it.
      assert.deepEqual(yield* itemTitles(threadId), trimmedItems);
      const nodes = yield* sql<{ readonly node_id: string }>`
        SELECT node_id FROM orchestration_v2_projection_nodes
        WHERE thread_id = ${threadId} ORDER BY node_id ASC
      `;
      assert.deepEqual(
        nodes.map((row) => row.node_id),
        ["node:idle:edit", "node:idle:root"],
      );
      const positions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_turn_item_positions
        WHERE thread_id = ${threadId}
      `;
      assert.equal(positions[0]?.count, trimmedItems.length);

      const { projection } = yield* store.getThreadSnapshot(threadId);
      assert.equal(DateTime.formatIso(projection.thread.updatedAt), DateTime.formatIso(old));
      const notice = projection.turnItems.at(-1);
      assert.equal(notice?.type, "system_notice");
      assert.include(
        notice?.type === "system_notice" ? notice.message : "",
        "removed to save space after 30 days",
      );
      const history = yield* store.getTurnStartHistory(threadId);
      assert.deepEqual(
        history.map((entry) => entry.type),
        ["user_message", "file_change", "assistant_message"],
      );
      const found = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_message_search
        WHERE orchestration_v2_message_search MATCH 'flaky idle harness'
      `;
      assert.equal(found[0]?.count, 1);

      assert.equal((yield* trim).threadCount, 0);
      assert.deepEqual(yield* itemTitles(threadId), trimmedItems);
    }),
  );

  it.effect("leaves threads that are in use, pinned, snoozed, or waiting on a pull request", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const root = yield* seedThread("live-root", { userMessageAt: recent });
      const kept = [
        root,
        yield* seedThread("recent-message", { userMessageAt: recent }),
        yield* seedThread("visited", { thread: { lastVisitedAt: recent } }),
        yield* seedThread("running", { runStatus: "running" }),
        yield* seedThread("pinned", { thread: { pinnedAt: old } }),
        yield* seedThread("snoozed", {
          thread: { snoozedAt: old, snoozedUntil: DateTime.add(now, { days: 1 }) },
        }),
        yield* seedThread("open-pr", {
          thread: {
            pullRequests: [
              {
                host: "github.com",
                repository: "acme/app",
                number: 7,
                url: "https://github.com/acme/app/pull/7",
                source: "agent",
                linkedAt: DateTime.formatIso(old),
                snapshot: {
                  state: "open",
                  title: "Fix harness",
                  headBranch: "fix",
                  baseBranch: "main",
                  isDraft: false,
                  updatedAt: null,
                  syncedAt: DateTime.formatIso(old),
                },
                stack: null,
              },
            ],
          },
        }),
        yield* seedThread("side-chat", {
          thread: {
            lineage: {
              parentThreadId: root.threadId,
              relationshipToParent: "fork",
              rootThreadId: root.threadId,
              sideChat: true,
            },
          },
        }),
        yield* seedThread("subagent-of-live-root", {
          thread: {
            lineage: {
              parentThreadId: root.threadId,
              relationshipToParent: "subagent",
              rootThreadId: root.threadId,
            },
          },
        }),
      ];
      const idleRoot = yield* seedThread("idle-root");
      const idleSubagent = yield* seedThread("subagent-of-idle-root", {
        thread: {
          lineage: {
            parentThreadId: idleRoot.threadId,
            relationshipToParent: "subagent",
            rootThreadId: idleRoot.threadId,
          },
        },
      });

      const report = yield* trim;
      for (const thread of kept) {
        assert.deepEqual(yield* itemTitles(thread.threadId), everyItem, thread.threadId);
      }
      assert.equal(report.threadCount, 2);
      assert.deepEqual(yield* itemTitles(idleRoot.threadId), trimmedItems);
      assert.deepEqual(yield* itemTitles(idleSubagent.threadId), trimmedItems);
    }),
  );
});

it.layer(layerTest(0))("ThreadHistoryTrim turned off", (it) => {
  it.effect("removes nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const { threadId } = yield* seedThread("off");
      assert.equal((yield* trim).threadCount, 0);
      assert.deepEqual(yield* itemTitles(threadId), everyItem);
    }),
  );
});

const lastTrimmedAt = Effect.gen(function* () {
  const service = yield* ThreadHistoryTrim.ThreadHistoryTrim;
  return Option.getOrThrow(yield* Stream.runHead(service.status)).lastTrimmedAt;
});
const afterWaiting = Effect.fn(function* (duration: Parameters<typeof TestClock.adjust>[0]) {
  yield* TestClock.adjust(duration);
  yield* (yield* ThreadHistoryTrim.ThreadHistoryTrim).drain;
});
// Each provide is one server run: the layer's scope closes with it, and the database outlives it.
const whileRunning = Effect.provide(ThreadHistoryTrim.layer);

it.layer(dependencies(30))("ThreadHistoryTrim schedule", (it) => {
  it.effect("runs a pass every 30 days, and at the next start when one was missed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const first = yield* seedThread("first");

      yield* Effect.gen(function* () {
        assert.isNull(yield* lastTrimmedAt);
        yield* afterWaiting("5 minutes");
        assert.deepEqual(yield* itemTitles(first.threadId), trimmedItems);
        const ranAt = yield* lastTrimmedAt;
        assert.equal(ranAt, DateTime.formatIso(DateTime.add(now, { minutes: 5 })));

        const second = yield* seedThread("second");
        yield* afterWaiting("29 days");
        assert.deepEqual(yield* itemTitles(second.threadId), everyItem);
        assert.equal(yield* lastTrimmedAt, ranAt);

        yield* afterWaiting("1 day");
        assert.deepEqual(yield* itemTitles(second.threadId), trimmedItems);
      }).pipe(whileRunning);

      const missed = yield* seedThread("missed");
      yield* TestClock.adjust("45 days");
      assert.deepEqual(yield* itemTitles(missed.threadId), everyItem);

      yield* Effect.gen(function* () {
        yield* afterWaiting("5 minutes");
        assert.deepEqual(yield* itemTitles(missed.threadId), trimmedItems);

        yield* TestClock.adjust("10 days");
        const requested = yield* seedThread("requested");
        yield* trim;
        assert.deepEqual(yield* itemTitles(requested.threadId), trimmedItems);

        // The requested trim reset the clock: 35 days after the last scheduled pass is too soon.
        const later = yield* seedThread("later");
        yield* afterWaiting("25 days");
        assert.deepEqual(yield* itemTitles(later.threadId), everyItem);
        yield* afterWaiting("5 days");
        assert.deepEqual(yield* itemTitles(later.threadId), trimmedItems);
      }).pipe(whileRunning);
    }),
  );
});

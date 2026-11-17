import { assert, it } from "@effect/vitest";
import {
  EventId,
  ServerSettingsError,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
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
import { visibleConversationItems } from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadHistoryTrim from "./ThreadHistoryTrim.ts";
import { buildBoundedThreadStreamSnapshot, invalidatesInheritedRows } from "./ThreadStream.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provideMerge(database)),
  ProjectionStore.layer.pipe(Layer.provideMerge(database)),
  ProjectStore.layer.pipe(Layer.provideMerge(database)),
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
  readonly extraReasoning?: number;
  /** A reasoning row under `command`, written after every other row. */
  readonly commandChild?: boolean;
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
        ...itemBase("html"),
        type: "dynamic_tool",
        toolName: "mcp__t3-code__html_render",
        input: null,
        output: { htmlRender: { title: "Chart" } },
      }),
      item({
        ...itemBase("app"),
        type: "dynamic_tool",
        toolName: "mcp__charts__show",
        input: null,
        output: { t3McpApp: { resourceUri: "ui://charts/show" } },
      }),
      item({
        ...itemBase("task"),
        type: "dynamic_tool",
        toolName: "mcp__t3-code__delegate_task",
        input: null,
        output: "The delegated task's result.",
      }),
      item({
        ...itemBase("assistant"),
        type: "assistant_message",
        messageId: assistantMessageId,
        text: "Fixed the harness.",
        streaming: false,
      }),
      ...Array.from({ length: options.extraReasoning ?? 0 }, (_, index) =>
        item({
          ...itemBase(`reasoning-${index}`),
          type: "reasoning",
          text: "more thinking",
          streaming: false,
        }),
      ),
      ...(options.commandChild === true
        ? [
            item({
              ...itemBase("command-child", null, "command"),
              type: "reasoning",
              text: "why the command ran",
              streaming: false,
            }),
          ]
        : []),
    ],
  });
  return { threadId, runId };
});

const openPullRequest = {
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
} satisfies NonNullable<OrchestrationV2AppThread["pullRequests"]>[number];

const createProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make("created:project:trim"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project:trim"),
    occurredAt: DateTime.formatIso(old),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: ProjectId.make("project:trim"),
      title: "trim",
      workspaceRoot: "/work/trim",
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(old),
      updatedAt: DateTime.formatIso(old),
    },
  }),
);

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

const inlineItems = ["sent", "html", "app", "task"];
const everyItem = ["user", "reasoning", "command", "tool", "edit", ...inlineItems, "assistant"];
// Inline items stay: the timeline always shows that output.
const trimmedItems = [
  "user",
  "tool",
  "edit",
  ...inlineItems,
  "assistant",
  "Older detail was trimmed",
];

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
        { dryRun: true, threadCount: 1, itemCount: everyItem.length - trimmedItems.length + 1 },
      );
      assert.isAbove(preview.estimatedBytes, 4_000);
      assert.deepEqual(yield* itemTitles(threadId), everyItem);

      const inlineIds = inlineItems.map((key) => `item:idle:${key}`);
      const report = yield* trim;
      assert.equal(report.dryRun, false);
      // What the web and mobile timelines, exports and transfers read keeps every inline output.
      const snapshot = yield* store.getThreadSnapshot(threadId);
      const wire = buildBoundedThreadStreamSnapshot(snapshot);
      const { turnItems, ...records } = yield* store.getThreadRecords(threadId, [
        "turnItems",
        "runs",
        "attempts",
      ]);
      const readers = {
        timeline: snapshot.projection.visibleTurnItems.map((row) => row.sourceItemId),
        wire: wire.projection.visibleTurnItems.map((row) => row.sourceItemId),
        transfer: visibleConversationItems(records, turnItems).map((item) => item.id),
      };
      for (const [reader, shown] of Object.entries(readers)) {
        assert.includeMembers(shown, inlineIds, reader);
      }
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
            pullRequests: [openPullRequest],
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

type Hook = Effect.Effect<
  void,
  EventSink.EventSinkV2Error | ProjectionStore.ProjectionStoreV2Error | ServerSettingsError,
  | EventSink.EventSinkV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ServerSettings.ServerSettingsService
>;
class TrimHook extends Context.Service<
  TrimHook,
  {
    /** Runs `hook` before the pass's `atWrite`th page: after it chose rows, before it removes them. */
    readonly arm: (hook: Hook, atWrite?: number) => Effect.Effect<void>;
    readonly disarm: Effect.Effect<void>;
    readonly next: Hook;
  }
>()("t3/orchestration-v2/ThreadHistoryTrim.test/TrimHook") {}
const trimHook = Layer.effect(
  TrimHook,
  Effect.sync(() => {
    let armed: { readonly hook: Hook; readonly atWrite: number; writes: number } | null = null;
    return TrimHook.of({
      arm: (hook, atWrite = 1) =>
        Effect.sync(() => {
          armed = { hook, atWrite, writes: 0 };
        }),
      disarm: Effect.sync(() => {
        armed = null;
      }),
      next: Effect.suspend(() =>
        armed !== null && ++armed.writes === armed.atWrite ? armed.hook : Effect.void,
      ),
    });
  }),
);
const hookedSink = Layer.effect(
  EventSink.EventSinkV2,
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const hooks = yield* TrimHook;
    const context = yield* Effect.context<Effect.Services<Hook>>();
    return EventSink.EventSinkV2.of({
      ...sink,
      writeBuilt: (build) =>
        hooks.next.pipe(
          Effect.provide(context),
          Effect.orDie,
          Effect.andThen(sink.writeBuilt(build)),
        ),
    });
  }),
);
// One migrated database for every hooked case; `isolate` clears what an earlier case left.
const hookedFixture = Layer.mergeAll(
  ThreadHistoryTrim.layer.pipe(Layer.provide(hookedSink)),
  Layer.effectDiscard(createProject),
).pipe(Layer.provideMerge(Layer.mergeAll(trimHook, dependencies(30))));
const isolate = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.toEpochMillis(now));
  yield* (yield* TrimHook).disarm;
  yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
    threadHistoryTrimAfterDays: 30,
  });
  yield* trim;
});
const arm = (hook: Hook, atWrite?: number) =>
  Effect.flatMap(TrimHook, (hooks) => hooks.arm(hook, atWrite));

const updateThread = (
  name: string,
  type: OrchestrationV2DomainEvent["type"],
  patch: Partial<OrchestrationV2AppThread>,
): Hook =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(`thread:trim:${name}`);
    const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(threadId);
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`event:${name}:activity`),
          type,
          threadId,
          occurredAt: now,
          payload: { ...thread, ...patch },
        } as OrchestrationV2DomainEvent,
      ],
    });
  });
const writeActivity = (name: string, event: (threadId: ThreadId, runId: RunId) => object): Hook =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(`thread:trim:${name}`);
    const runId = RunId.make(`run:${threadId}:2`);
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`event:${name}:activity`),
          threadId,
          runId,
          occurredAt: now,
          ...event(threadId, runId),
        } as OrchestrationV2DomainEvent,
      ],
    });
  });

const activities: ReadonlyArray<readonly [string, Hook]> = [
  ["opened", updateThread("opened", "thread.visited", { lastVisitedAt: now })],
  ["pinned", updateThread("pinned", "thread.pinned", { pinnedAt: now })],
  [
    "snoozed",
    updateThread("snoozed", "thread.snoozed", {
      snoozedAt: now,
      snoozedUntil: DateTime.add(now, { days: 1 }),
    }),
  ],
  [
    "pr-linked",
    updateThread("pr-linked", "thread.pull-request-synced", { pullRequests: [openPullRequest] }),
  ],
  [
    "messaged",
    writeActivity("messaged", (threadId, runId) => ({
      type: "message.updated",
      payload: {
        id: MessageId.make("message:messaged:again"),
        threadId,
        runId,
        nodeId: null,
        role: "user",
        text: "one more thing",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    })),
  ],
  [
    "run",
    writeActivity("run", (threadId, runId) => ({
      type: "run.created",
      payload: {
        id: runId,
        threadId,
        ordinal: 2,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:run:again"),
        rootNodeId: NodeId.make("node:run:again"),
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    })),
  ],
  [
    "trimming-off",
    Effect.flatMap(ServerSettings.ServerSettingsService, (settings) =>
      settings.updateSettings({ threadHistoryTrimAfterDays: 0 }),
    ),
  ],
];

const ids = (projection: OrchestrationV2ThreadProjection) => ({
  turnItems: projection.turnItems.map((item) => item.id).toSorted(),
  nodes: projection.nodes.map((node) => node.id).toSorted(),
  visible: projection.visibleTurnItems.map((row) => row.sourceItemId),
});
type Snapshot = {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
};

/** A client that read `threadId` mid-pass, left the caches warm, and then replays its stream. */
const midPassReader = (threadId: ThreadId) => {
  let warmed: Snapshot | undefined;
  const read: Hook = Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    warmed = yield* store.getThreadSnapshot(threadId);
    yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 50 });
    yield* store.searchThread({ threadId, query: "flaky" });
  });
  /** A fork's replay holds compact copies, which subscribers answer with a fresh snapshot. */
  const verify = (removed: Array<string>, fork = false) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const before = warmed!;
      assert.includeMembers(ids(before.projection).visible, removed);

      const after = yield* store.getThreadSnapshot(threadId);
      assert.isAbove(after.snapshotSequence, before.snapshotSequence);
      assert.notIncludeMembers(ids(after.projection).visible, removed);
      // The events a live subscriber hears, and a reconnect after `before` replays.
      const replay = yield* Stream.runCollect(
        (yield* EventStore.EventStoreV2).read({ threadId, afterSequence: before.snapshotSequence }),
      );
      if (fork) {
        const copies = replay.filter((stored) => invalidatesInheritedRows(stored.event, threadId));
        assert.isNotEmpty(copies);
        for (const copy of copies) {
          assert.isAtMost(JSON.stringify(copy.event.payload).length, 128);
        }
      } else {
        const resumed = replay.reduce(
          (projection, stored) => ProjectionStore.applyToProjection(projection, stored.event),
          before.projection,
        );
        assert.deepEqual(ids(resumed), ids(after.projection));
      }

      const window = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 50 });
      assert.equal(window.snapshotSequence, after.snapshotSequence);
      assert.notIncludeMembers(ids(window.projection).visible, removed);
      const found = yield* store.searchThread({ threadId, query: "flaky" });
      assert.equal(found.snapshotSequence, after.snapshotSequence);
    });
  return { read, verify };
};

const orphanedItems = Effect.fn(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: string }>`
    SELECT child.turn_item_id AS id FROM orchestration_v2_projection_turn_items AS child
    WHERE child.thread_id = ${threadId} AND child.parent_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS parent
        WHERE parent.turn_item_id = child.parent_item_id
      )
  `;
  return rows.map((row) => row.id);
});

it.layer(hookedFixture)("ThreadHistoryTrim during a pass", (it) => {
  it.effect.each(activities)("stops trimming a thread that is %s", ([name, activity]) =>
    Effect.gen(function* () {
      yield* isolate;
      const { threadId } = yield* seedThread(name);
      yield* arm(activity);
      yield* trim;
      assert.deepEqual(yield* itemTitles(threadId), everyItem);
    }),
  );

  it.effect("stops between pages without orphaning a kept row", () =>
    Effect.gen(function* () {
      yield* isolate;
      const name = "opened-between-pages";
      // `command` sorts into the first page and its child into the second, unless children go first.
      const { threadId } = yield* seedThread(name, { extraReasoning: 250, commandChild: true });
      yield* arm(updateThread(name, "thread.visited", { lastVisitedAt: now }), 2);
      yield* trim;
      assert.lengthOf(yield* itemTitles(threadId), everyItem.length + 251 - 200 + 1);
      assert.deepEqual(yield* orphanedItems(threadId), []);
    }),
  );

  it.effect("keeps a row that gains a child after the pass chose it", () =>
    Effect.gen(function* () {
      yield* isolate;
      const name = "gains-child";
      const { threadId, runId } = yield* seedThread(name);
      const child: Hook = Effect.flatMap(EventSink.EventSinkV2, (sink) =>
        sink.write({
          events: [
            {
              id: EventId.make(`event:${name}:child`),
              type: "turn-item.updated",
              threadId,
              runId,
              occurredAt: old,
              payload: {
                id: TurnItemId.make(`item:${name}:late-edit`),
                threadId,
                runId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: TurnItemId.make(`item:${name}:command`),
                ordinal: 0,
                status: "completed",
                title: "late-edit",
                startedAt: old,
                completedAt: old,
                updatedAt: old,
                type: "file_change",
                fileName: "late.ts",
              },
            },
          ],
        }),
      );
      yield* arm(child);
      yield* trim;
      assert.include(yield* itemTitles(threadId), "command");
      assert.deepEqual(yield* orphanedItems(threadId), []);
    }),
  );

  it.effect(
    "advances the thread's revision so reconnects, windows and search drop trimmed rows",
    () =>
      Effect.gen(function* () {
        yield* isolate;
        const name = "reconnect";
        const { threadId } = yield* seedThread(name);
        const reader = midPassReader(threadId);
        yield* arm(reader.read);
        yield* trim;
        yield* reader.verify([`item:${name}:reasoning`, `item:${name}:command`]);
      }),
  );

  it.effect("advances the revision of every live fork, through deleted forks, compactly", () =>
    Effect.gen(function* () {
      yield* isolate;
      const source = yield* seedThread("fork-source");
      const forkOf = (name: string, parent: { threadId: ThreadId; runId: RunId }) =>
        seedThread(name, {
          userMessageAt: recent,
          thread: {
            lineage: {
              parentThreadId: parent.threadId,
              relationshipToParent: "fork",
              rootThreadId: source.threadId,
            },
            forkedFrom: { type: "run", threadId: parent.threadId, runId: parent.runId },
          },
        });
      const fork = yield* forkOf("fork", source);
      const deleted = yield* forkOf("deleted-fork", source);
      const grandchild = yield* forkOf("fork-of-deleted", deleted);
      yield* updateThread("deleted-fork", "thread.deleted", { deletedAt: now });
      const deletedEvents = Stream.runCollect(
        (yield* EventStore.EventStoreV2).read({ threadId: deleted.threadId }),
      );
      const deletedBefore = (yield* deletedEvents).length;

      const readers = [midPassReader(grandchild.threadId), midPassReader(fork.threadId)];
      yield* arm(Effect.forEach(readers, (reader) => reader.read, { discard: true }));
      yield* trim;
      for (const reader of readers) {
        yield* reader.verify(["item:fork-source:reasoning", "item:fork-source:command"], true);
      }
      assert.lengthOf(yield* deletedEvents, deletedBefore);
      assert.deepEqual(yield* itemTitles(fork.threadId), everyItem);
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

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
  backgroundThreadUpdatesKeepTimestamp,
} from "./ProjectionStore-fixtures.testkit.ts";

it.effect("SQL shells use the latest subagent owner for duplicate provider-thread ids", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("duplicate-provider-thread-owner");
    const initial = yield* store.getThreadProjection(threadId);
    const at = initial.updatedAt;
    const otherThreadId = yield* addRolledBackRecoveryCandidate(
      "duplicate-provider-thread-owner:other",
    );
    const other = yield* store.getThreadProjection(otherThreadId);
    const otherRun = other.runs[0]!;
    const otherInstanceId = ProviderInstanceId.make("codex-other");
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:other-completed"),
      type: "run.updated",
      threadId: otherThreadId,
      occurredAt: at,
      payload: { ...otherRun, status: "completed", completedAt: at },
    });
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:other-switched"),
      type: "thread.provider-switched",
      threadId: otherThreadId,
      occurredAt: at,
      payload: {
        ...other.thread,
        providerInstanceId: otherInstanceId,
        modelSelection: { ...modelSelection, instanceId: otherInstanceId },
      },
    });
    const providerThreadId = ProviderThreadId.make("provider-thread:duplicate-owner");
    const nativeTaskId = "native-task:duplicate-provider-thread-owner";
    for (const [appThreadId, owner] of [
      [otherThreadId, otherInstanceId],
      [threadId, providerInstanceId],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:duplicate-provider-thread-owner:${owner}`),
        type: "provider-thread.updated",
        threadId: appThreadId,
        occurredAt: at,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: owner,
          providerSessionId: null,
          appThreadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: at,
          updatedAt: at,
          pendingBackgroundTasks:
            owner === otherInstanceId
              ? [{ taskId: nativeTaskId, kind: "subagent", description: "Review" }]
              : [],
        },
      });
    }
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:completed"),
      type: "run.updated",
      threadId,
      occurredAt: at,
      payload: { ...initial.runs[0]!, status: "completed", completedAt: at },
    });
    const item = {
      ...initial.turnItems[0]!,
      id: TurnItemId.make("item:duplicate-provider-thread-owner"),
      providerThreadId,
      nativeItemRef: { driver, nativeId: nativeTaskId, strength: "strong" as const },
      type: "subagent" as const,
      status: "running" as const,
      subagentId: NodeId.make("node:duplicate-provider-thread-owner"),
      origin: "provider_native" as const,
      driver,
      providerInstanceId,
      childThreadId: null,
      title: "Review",
      prompt: "Review",
      result: null,
    };
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:item"),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: item,
    });
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:other-item"),
      type: "turn-item.updated",
      threadId: otherThreadId,
      occurredAt: at,
      payload: {
        ...item,
        id: TurnItemId.make("item:duplicate-provider-thread-owner:other"),
        threadId: otherThreadId,
        runId: otherRun.id,
        nodeId: otherRun.rootNodeId,
        subagentId: NodeId.make("node:duplicate-provider-thread-owner:other"),
      },
    });
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:switched"),
      type: "thread.provider-switched",
      threadId,
      occurredAt: at,
      payload: {
        ...initial.thread,
        providerInstanceId: otherInstanceId,
        modelSelection: { ...modelSelection, instanceId: otherInstanceId },
      },
    });
    assert.deepEqual((yield* store.getThreadProjection(otherThreadId)).providerThreads, []);
    const assertOwners = Effect.fnUntraced(function* (
      targetThreadId: ThreadId,
      expected: ReadonlyArray<unknown>,
    ) {
      const listed = (yield* store.getShellSnapshot()).threads.find(
        (thread) => thread.id === targetThreadId,
      );
      yield* assertShellIndexCoversShells();
      for (const shell of [yield* store.getThreadShell(targetThreadId), listed]) {
        assert.equal(shell?.providerInstanceId, otherInstanceId);
        assert.equal(shell?.activeRunId, null);
        assert.deepEqual(
          shell?.pendingBackgroundTasks?.filter((task) => task.kind === "subagent"),
          expected,
        );
      }
    });
    const owned = [
      { taskId: nativeTaskId, description: item.title, kind: "subagent", providerInstanceId },
    ];
    yield* assertOwners(threadId, owned);
    yield* assertOwners(otherThreadId, owned);
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:stopped"),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: { ...item, status: "cancelled", completedAt: at },
    });
    yield* assertOwners(threadId, []);
    const ownerSnapshot = (yield* store.getThreadProjection(threadId)).providerThreads[0]!;
    // Rollback writes its provider snapshot before the rolled-back run events.
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:rollback-provider-thread"),
      type: "provider-thread.updated",
      threadId: otherThreadId,
      occurredAt: at,
      payload: ownerSnapshot,
    });
    yield* store.apply({
      id: EventId.make("event:duplicate-provider-thread-owner:other-rolled-back"),
      type: "run.updated",
      threadId: otherThreadId,
      occurredAt: at,
      payload: { ...otherRun, status: "rolled_back", completedAt: at },
    });
    const rolledBack = yield* store.getThreadProjection(otherThreadId);
    assert.deepEqual(rolledBack.providerThreads, []);
    assert.equal(
      (yield* store.getThreadProjection(threadId)).thread.activeProviderThreadId,
      providerThreadId,
    );
    assert.deepEqual(
      ProjectionStore.threadShellFromProjection(rolledBack).pendingBackgroundTasks,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);
it.effect("SQL projection keeps background thread updates out of updatedAt", () =>
  backgroundThreadUpdatesKeepTimestamp.pipe(Effect.provide(layerTest)),
);
it.effect("SQL shells read a subagent family and a worktree's threads", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:family");
    const worktreePath = "/repo/.t3/worktrees/family";
    const id = (name: string) => ThreadId.make(`thread:family:${name}`);
    const payloadOf = (input: {
      readonly name: string;
      readonly parent?: string;
      readonly root?: string;
      readonly worktreePath?: string;
      readonly archived?: boolean;
    }) =>
      ({
        createdBy: "user",
        creationSource: input.parent === undefined ? "web" : "mcp",
        id: id(input.name),
        projectId,
        title: input.name,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: input.worktreePath ?? null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: input.parent === undefined ? null : id(input.parent),
          relationshipToParent: input.parent === undefined ? null : "subagent",
          rootThreadId: id(input.root ?? input.name),
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived === true ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      }) as const;
    const createThread = (input: Parameters<typeof payloadOf>[0]) =>
      store.apply({
        id: EventId.make(`event:family:${input.name}`),
        type: "thread.created",
        threadId: id(input.name),
        occurredAt: now,
        payload: payloadOf(input),
      });
    yield* createThread({ name: "root", worktreePath });
    yield* createThread({ name: "child", parent: "root", root: "root", worktreePath });
    yield* createThread({ name: "grandchild", parent: "child", root: "root" });
    yield* createThread({ name: "archived-child", parent: "root", root: "root", archived: true });
    yield* createThread({ name: "other", worktreePath: "/repo" });
    yield* createThread({ name: "other-child", parent: "other", root: "other", worktreePath });

    const family = (threadId: ThreadId) =>
      store
        .getShellSnapshot({ location: "active", familyOf: threadId })
        .pipe(Effect.map((snapshot) => snapshot.threads.map((thread) => thread.id)));
    // Any member, or the root itself, names the same active tree, root included.
    const tree = [id("root"), id("child"), id("grandchild")];
    assert.sameMembers([...(yield* family(id("root")))], tree);
    assert.sameMembers([...(yield* family(id("grandchild")))], tree);
    assert.deepEqual([...(yield* family(id("missing")))], []);

    // Includes another root's idle child on the same path, which a shell may leave out.
    const onWorktree = yield* store.getShellSnapshot({ location: "active", worktreePath });
    assert.sameMembers(
      onWorktree.threads.map((thread) => thread.id),
      [id("root"), id("child"), id("other-child")],
    );
    // A fork keeps its deleted source's root, so the deleted root still names the live tree.
    yield* store.apply({
      id: EventId.make("event:family:root-deleted"),
      type: "thread.deleted",
      threadId: id("root"),
      occurredAt: now,
      payload: { ...payloadOf({ name: "root", worktreePath }), deletedAt: now },
    });
    assert.sameMembers([...(yield* family(id("root")))], [id("child"), id("grandchild")]);
  }).pipe(Effect.provide(layerTest)),
);
it.effect("SQL list older settled threads below a cursor", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const id = (name: string) => ThreadId.make(`thread:older:${name}`);
    const at = (day: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, day));
    const createThread = (input: {
      readonly name: string;
      readonly settledDay: number | null;
      readonly project?: string;
      readonly subagent?: boolean;
      readonly archived?: boolean;
      readonly snoozedUntilDay?: number;
    }) =>
      store.apply({
        id: EventId.make(`event:older:${input.name}`),
        type: "thread.created",
        threadId: id(input.name),
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: id(input.name),
          projectId: ProjectId.make(input.project ?? "project:a"),
          title: input.name,
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: input.subagent === true ? id("b") : null,
            relationshipToParent: input.subagent === true ? "subagent" : null,
            rootThreadId: input.subagent === true ? id("b") : id(input.name),
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: input.archived === true ? now : null,
          settledOverride: input.settledDay === null ? null : "settled",
          settledAt: input.settledDay === null ? null : at(input.settledDay),
          snoozedUntil: input.snoozedUntilDay === undefined ? null : at(input.snoozedUntilDay),
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
    yield* createThread({ name: "a", settledDay: 5 });
    yield* createThread({ name: "b", settledDay: 4 });
    yield* createThread({ name: "c", settledDay: 4 });
    yield* createThread({ name: "d", settledDay: 3, project: "project:b" });
    yield* createThread({ name: "snoozed", settledDay: 2, snoozedUntilDay: 30 });
    yield* createThread({ name: "recent", settledDay: 20 });
    yield* createThread({ name: "unsettled", settledDay: null });
    yield* createThread({ name: "child", settledDay: 1, subagent: true });
    yield* createThread({ name: "archived", settledDay: 1, archived: true });

    const list = (
      before: { readonly settledAt: string; readonly threadId?: ThreadId },
      limit: number,
      projectIds?: ReadonlyArray<ProjectId>,
    ) => store.listOlderSettledThreads({ before, projectIds, limit });
    const before = { settledAt: DateTime.formatIso(at(10)) };
    const first = yield* list(before, 2);
    assert.deepEqual(first, { threadIds: [id("a"), id("b")], counts: [] });
    assert.sameDeepMembers(
      [...(yield* list(before, 0)).counts],
      [
        { projectId: ProjectId.make("project:a"), count: 4 },
        { projectId: ProjectId.make("project:b"), count: 1 },
      ],
    );
    // A cursor without an id is strict, as the snapshot's cut is: the day-4 tie is not counted.
    assert.sameDeepMembers(
      [...(yield* list({ settledAt: DateTime.formatIso(at(4)) }, 0)).counts],
      [
        { projectId: ProjectId.make("project:a"), count: 1 },
        { projectId: ProjectId.make("project:b"), count: 1 },
      ],
    );
    // The cursor is the last row: the tie on day 4 continues by id.
    const next = yield* list({ settledAt: DateTime.formatIso(at(4)), threadId: id("b") }, 10);
    assert.deepEqual(next.threadIds, [id("c"), id("d"), id("snoozed")]);
    assert.deepEqual(yield* list(before, 25, []), { threadIds: [], counts: [] });
    yield* assertShellIndexCoversShells();
    const scoped = yield* list(before, 0, [ProjectId.make("project:b")]);
    assert.deepEqual(scoped, {
      threadIds: [],
      counts: [{ projectId: ProjectId.make("project:b"), count: 1 }],
    });
  }).pipe(Effect.provide(layerTest)),
);
it.effect("lists only active subagent IDs without loading shell data", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const createdAt = "2026-01-05T00:00:00.000Z";
    for (const [id, relationship, archivedAt, deletedAt] of [
      ["parent", null, null, null],
      ["active-subagent", "subagent", null, null],
      ["archived-subagent", "subagent", createdAt, null],
      ["deleted-subagent", "subagent", null, createdAt],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${id}, 'project:test', ${id}, 'codex', 'full-access', 'default',
          ${createdAt}, ${createdAt}, ${archivedAt}, ${deletedAt},
          ${JSON.stringify({ lineage: { relationshipToParent: relationship }, archivedAt })}
        )
      `;
    }

    assert.sameMembers(
      [...(yield* store.listActiveSubagentThreadIds())],
      [ThreadId.make("active-subagent")],
    );
  }).pipe(Effect.provide(layerTest)),
);

// regression: #25621 SQLite rejects statements binding more than 32,766 variables
it.effect("lists every thread in the shell snapshot past SQLite's bound variable limit", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const templateId = ThreadId.make("thread:many:00000");
    yield* store.apply({
      id: EventId.make(`event:${templateId}:created`),
      type: "thread.created",
      threadId: templateId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: templateId,
        projectId: ProjectId.make("project:many"),
        title: "Many",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: templateId },
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
    const threadCount = 32_767;
    yield* sql`
      CREATE TEMP TABLE many_threads AS
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${threadCount - 1})
      SELECT t.*, n.i AS clone_index FROM orchestration_v2_projection_threads t, n
      WHERE t.thread_id = ${templateId}
    `;
    yield* sql`
      UPDATE many_threads SET
        thread_id = printf('thread:many:%05d', clone_index),
        payload_json = json_set(
          payload_json,
          '$.id', printf('thread:many:%05d', clone_index),
          '$.lineage.rootThreadId', printf('thread:many:%05d', clone_index)
        )
    `;
    yield* sql`ALTER TABLE many_threads DROP COLUMN clone_index`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM many_threads`;

    const [unscoped, active] = yield* Effect.all([
      store.getShellSnapshot(),
      store.getShellSnapshot({ location: "active" }),
    ]);
    assert.strictEqual(unscoped.threads.length, threadCount);
    assert.strictEqual(active.threads.length, threadCount);
  }).pipe(Effect.provide(layerTest)),
);

import { assert, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationSearchThreadsInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ToolSearch from "./ToolSearch.ts";
import { backfillToolSearchBatch, resetToolSearch } from "./toolSearchIndex.ts";

const layerTest = Layer.mergeAll(ToolSearch.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));
const projectId = ProjectId.make("tool-search");
const isThreadSearchInput = Schema.is(OrchestrationSearchThreadsInput);

const setup = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`created:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: DateTime.formatIso(at(0)),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: projectId,
      workspaceRoot: `/work/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(at(0)),
      updatedAt: DateTime.formatIso(at(0)),
    },
  }),
);

const thread = (
  threadId: ThreadId,
  overrides: {
    readonly archivedAt?: DateTime.Utc;
    readonly deletedAt?: DateTime.Utc;
    readonly projectId?: ProjectId;
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}:${overrides.deletedAt === undefined ? "" : "deleted"}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: overrides.projectId ?? projectId,
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const command = (
  threadId: ThreadId,
  id: string,
  output: string,
  status: "running" | "completed" = "completed",
  minute = 1,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`item:${id}:${minute}:${status}`),
  type: "turn-item.updated",
  threadId,
  driver,
  occurredAt: at(minute),
  payload: {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: minute,
    status,
    title: null,
    startedAt: at(minute),
    completedAt: status === "completed" ? at(minute) : null,
    updatedAt: at(minute),
    type: "command_execution",
    input: "vp test run",
    output,
    ...(status === "completed" ? { exitCode: 1 } : {}),
  },
});

const hits = (query: string, options: { readonly includeArchived?: boolean } = {}) =>
  Effect.flatMap(ToolSearch.ToolSearch, (search) =>
    search.search({ query, projectId, ...options }),
  ).pipe(Effect.map((result) => result.matches.map((match) => match.itemId)));

it.layer(layerTest)("ToolSearch", (it) => {
  it.effect("finds words anywhere in finished output, across lines", () =>
    Effect.gen(function* () {
      yield* setup;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("tool-lines");
      yield* projections.apply(thread(threadId));
      const middle = `${"ok\n".repeat(5_000)}FAILED kernel_xattr_roundtrip\n${"ok\n".repeat(5_000)}`;
      yield* projections.apply(command(threadId, "item:lines", middle));
      assert.deepEqual(yield* hits("FAILED kernel_xattr_roundtrip"), [
        TurnItemId.make("item:lines"),
      ]);
      const search = yield* ToolSearch.ToolSearch;
      const result = yield* search.search({ query: "kernel_xattr_roundtrip", projectId });
      assert.include(result.matches[0]?.snippet ?? "", "FAILED kernel_xattr_roundtrip");
      assert.isTrue(result.complete);
    }),
  );

  it.effect("indexes an item when it finishes and replaces its terms on rewrite", () =>
    Effect.gen(function* () {
      yield* setup;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("tool-rewrite");
      yield* projections.apply(thread(threadId));
      yield* projections.apply(command(threadId, "item:rewrite", "streaming alpha", "running"));
      assert.deepEqual(yield* hits("alpha"), []);
      yield* projections.apply(command(threadId, "item:rewrite", "final beta", "completed", 2));
      assert.deepEqual(yield* hits("beta"), [TurnItemId.make("item:rewrite")]);
      yield* projections.apply(command(threadId, "item:rewrite", "final gamma", "completed", 3));
      assert.deepEqual(yield* hits("beta"), []);
      assert.deepEqual(yield* hits("gamma"), [TurnItemId.make("item:rewrite")]);
      yield* projections.apply(command(threadId, "item:rewrite", "streaming delta", "running", 4));
      assert.deepEqual(yield* hits("gamma"), []);
      assert.deepEqual(yield* hits("delta"), []);
    }),
  );

  it.effect("scopes and pages older tool evidence beyond newer matching items", () =>
    Effect.gen(function* () {
      yield* setup;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const other = ProjectId.make("other-tool-project");
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${other}, 'Other', '/work/other', '[]', '2026-01-01', '2026-01-01')`;
      const older = ThreadId.make("z-tool-older");
      const newer = ThreadId.make("a-tool-newer");
      yield* projections.apply(thread(older));
      yield* projections.apply(thread(newer, { projectId: other }));
      yield* projections.apply(command(older, "item:older", "needle"));
      yield* projections.apply(command(newer, "item:newer", "needle"));
      const [template] = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:newer'`;
      yield* sql`
        WITH RECURSIVE seq(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM seq WHERE n < 10001)
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json, inline_work_output
        ) SELECT 'item:newer:' || n, ${newer}, n, 'command_execution', 'completed',
          ${DateTime.formatIso(at(2))},
          json_set(${template!.payload}, '$.id', 'item:newer:' || n, '$.ordinal', n), 0 FROM seq`;
      yield* sql`INSERT OR REPLACE INTO orchestration_v2_tool_search (rowid, text)
        SELECT rowid, 'needle' FROM orchestration_v2_projection_turn_items WHERE thread_id = ${newer}`;
      const search = yield* ToolSearch.ToolSearch;
      assert.deepEqual(yield* hits("needle"), [TurnItemId.make("item:older")]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = ${projectId}
        WHERE thread_id = ${newer}`;
      const first = yield* search.search({ query: "needle", projectId, limit: 1 });
      assert.equal(first.matches[0]?.threadId, newer);
      assert.isNotNull(first.nextCursor);
      const second = yield* search.search({
        query: "needle",
        projectId,
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.deepEqual(
        second.matches.map((hit) => hit.itemId),
        [TurnItemId.make("item:older")],
      );
      assert.isNull(second.nextCursor);
      const messageCursor = { ...first.nextCursor!, source: "messages" as const };
      const mismatch = yield* search
        .search({ query: "needle", projectId, cursor: messageCursor })
        .pipe(Effect.flip);
      assert.equal(mismatch.operation, "cursor");
      assert.isFalse(isThreadSearchInput({ query: "alpha\u0000beta" }));
    }),
  );

  it.effect("leaves out binary payloads, deleted threads and unrequested archives", () =>
    Effect.gen(function* () {
      yield* setup;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const encoded = "QUJD".repeat(2_000) + "aZ09";
      const live = ThreadId.make("tool-live");
      const archived = ThreadId.make("tool-archived");
      const deleted = ThreadId.make("tool-deleted");
      yield* projections.apply(thread(live));
      yield* projections.apply(thread(archived, { archivedAt: at(5) }));
      yield* projections.apply(thread(deleted));
      for (const threadId of [live, archived, deleted]) {
        yield* projections.apply(
          command(threadId, `item:${threadId}`, `shared marker data:image/png;base64,${encoded}`),
        );
      }
      yield* projections.apply(thread(deleted, { deletedAt: at(6) }));
      yield* projections.apply({
        ...command(live, "item:echo", "marker"),
        payload: {
          ...command(live, "item:echo", "marker").payload,
          type: "dynamic_tool",
          toolName: "mcp__t3-code__t3_thread_search",
          input: { query: "marker" },
          output: { matches: [] },
        },
      } as OrchestrationV2DomainEvent);
      assert.deepEqual(yield* hits("marker"), [TurnItemId.make("item:tool-live")]);
      assert.deepEqual((yield* hits("marker", { includeArchived: true })).toSorted(), [
        TurnItemId.make("item:tool-archived"),
        TurnItemId.make("item:tool-live"),
      ]);
      assert.deepEqual(yield* hits(encoded.slice(0, 64)), []);
    }),
  );

  it.effect("backfills older items without overwriting a newer projection write", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("tool-backfill");
      yield* projections.apply(thread(threadId));
      for (let index = 0; index < 450; index += 1) {
        yield* projections.apply(command(threadId, `item:old:${index}`, `history ${index} delta`));
      }
      yield* resetToolSearch(sql);
      const search = yield* ToolSearch.ToolSearch;
      const pending = yield* search.search({ query: "delta", projectId });
      assert.deepEqual(pending.matches, []);
      assert.isFalse(pending.complete);
      assert.isFalse(yield* backfillToolSearchBatch(sql));
      yield* projections.apply(
        command(threadId, "item:old:449", "rewritten epsilon", "completed", 9),
      );
      while (!(yield* backfillToolSearchBatch(sql))) {}
      assert.deepEqual(yield* hits("epsilon"), [TurnItemId.make("item:old:449")]);
      const done = yield* search.search({ query: "history 0", projectId });
      assert.isTrue(done.complete);
      const counted = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM orchestration_v2_tool_search
        WHERE orchestration_v2_tool_search MATCH 'delta'
      `;
      assert.equal(counted[0]?.n, 449);
    }),
  );
});

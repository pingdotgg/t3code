import { assert, it } from "../../../apps/server/node_modules/@effect/vitest/dist/index.js";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "../../../apps/server/node_modules/@t3tools/contracts/src/index.ts";
import * as Cause from "../../../apps/server/node_modules/effect/dist/Cause.js";
import * as DateTime from "../../../apps/server/node_modules/effect/dist/DateTime.js";
import * as Effect from "../../../apps/server/node_modules/effect/dist/Effect.js";
import * as SqlClient from "../../../apps/server/node_modules/effect/dist/unstable/sql/SqlClient.js";

import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "../../../apps/server/src/orchestration-v2/IdAllocator.ts";
import {
  applyToProjection,
  emptyProjection,
  threadShellFromProjection,
} from "../../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import { isAutoSettlementCandidate } from "../../../apps/server/src/orchestration-v2/ThreadSettlementService.ts";
import {
  migrationEntries,
  runMigrations,
} from "../../../apps/server/src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../../../packages/shared/src/nodeSqliteClient.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(
  threadId: ThreadId,
  now: DateTime.Utc,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
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
    ...overrides,
  };
}

function threadCreatedEvent(
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
): Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }> {
  return {
    id: EventId.make(`event:create:${thread.id}`),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  };
}

const applyHistoricalCohort = (
  mappings: ReadonlyArray<readonly [currentId: number, historicalId: number]>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [currentId, historicalId] of mappings) {
      const entry = migrationEntries.find(([id]) => id === currentId);
      assert.ok(entry, `missing current migration ${currentId}`);
      const [, name, migration] = entry;
      yield* migration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${historicalId}, ${name})
      `;
    }
  });

it.effect("upgrades committed-058 state through the live-059 overlay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 58 });
    const executed = yield* runMigrations();
    assert.deepStrictEqual(executed, [[59, "OrchestrationV2ShellIndexes"]]);
    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'orchestration_v2_%_idx'
    `;
    const names = new Set(indexes.map(({ name }) => name));
    assert.strictEqual(names.has("orchestration_v2_projection_turn_items_shell_pending_idx"), true);
    assert.strictEqual(names.has("orchestration_v2_projection_messages_latest_user_idx"), true);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reproduces the old-052 cohort collision against the current migrator", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* applyHistoricalCohort(
      Array.from({ length: 9 }, (_, offset) => [48 + offset, 44 + offset] as const),
    );

    const before = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name
      FROM effect_sql_migrations
      ORDER BY migration_id DESC
      LIMIT 1
    `;
    assert.deepStrictEqual(before, [{ migration_id: 52, name: "LegacyV1ImportState" }]);

    const exit = yield* Effect.exit(runMigrations());
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.pretty(exit.cause);
      assert.match(failure, /Migration "53_ApplicationEventSource" failed/);
      assert.match(failure, /duplicate column name|already exists/i);
    }

    const after = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name
      FROM effect_sql_migrations
      ORDER BY migration_id DESC
      LIMIT 1
    `;
    assert.deepStrictEqual(after, before);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reproduces the old-055 cohort collision and skipped main columns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 44 });
    yield* applyHistoricalCohort([
      ...Array.from({ length: 9 }, (_, offset) => [48 + offset, 45 + offset] as const),
      [57, 54],
      [58, 55],
    ]);

    const projectColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('projection_projects')
    `;
    const columnNames = new Set(projectColumns.map(({ name }) => name));
    assert.strictEqual(columnNames.has("auto_pull"), false);
    assert.strictEqual(columnNames.has("project_icon"), false);

    const exit = yield* Effect.exit(runMigrations());
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.pretty(exit.cause);
      assert.match(failure, /Migration "56_LegacyV1ImportState" failed/);
      assert.match(failure, /already exists/i);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reproduces the prior-audit old-053 cohort collision", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 44 });
    yield* applyHistoricalCohort(
      Array.from({ length: 9 }, (_, offset) => [48 + offset, 45 + offset] as const),
    );

    const before = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name
      FROM effect_sql_migrations
      ORDER BY migration_id DESC
      LIMIT 1
    `;
    assert.deepStrictEqual(before, [{ migration_id: 53, name: "LegacyV1ImportState" }]);

    const exit = yield* Effect.exit(runMigrations());
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.pretty(exit.cause);
      assert.match(failure, /Migration "56_LegacyV1ImportState" failed/);
      assert.match(failure, /already exists/i);
    }

    const after = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name
      FROM effect_sql_migrations
      ORDER BY migration_id DESC
      LIMIT 1
    `;
    assert.deepStrictEqual(after, before);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reproduces root checkpoint-scope reuse across ordinary runs", () =>
  Effect.gen(function* () {
    const ids = yield* IdAllocatorV2;
    const threadId = ThreadId.make("thread:audit-scope");
    const now = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
    const firstScopeId = yield* ids.allocate.checkpointScope({ threadId, name: "root" });
    const secondScopeId = yield* ids.allocate.checkpointScope({ threadId, name: "root" });
    const firstRunId = RunId.make("run:audit-scope:1");
    const secondRunId = RunId.make("run:audit-scope:2");
    const providerThreadId = ProviderThreadId.make("provider-thread:audit-scope");
    let projection = emptyProjection(threadCreatedEvent(makeThread(threadId, now), now));
    const scopeEvent = (
      eventId: EventId,
      scopeId: typeof firstScopeId,
      runId: RunId,
      nodeId: NodeId,
    ): Extract<OrchestrationV2DomainEvent, { readonly type: "checkpoint-scope.created" }> => ({
      id: eventId,
      type: "checkpoint-scope.created",
      threadId,
      runId,
      nodeId,
      occurredAt: now,
      payload: {
        id: scopeId,
        threadId,
        runId,
        nodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo",
        createdAt: now,
      },
    });

    projection = applyToProjection(
      projection,
      scopeEvent(
        EventId.make("event:scope:1"),
        firstScopeId,
        firstRunId,
        NodeId.make("node:scope:1"),
      ),
    );
    projection = applyToProjection(
      projection,
      scopeEvent(
        EventId.make("event:scope:2"),
        secondScopeId,
        secondRunId,
        NodeId.make("node:scope:2"),
      ),
    );

    assert.strictEqual(firstScopeId, secondScopeId);
    assert.strictEqual(projection.checkpointScopes.length, 1);
    assert.strictEqual(projection.checkpointScopes[0]?.runId, secondRunId);
  }).pipe(Effect.provide(idAllocatorLayer)),
);

it("reproduces a stale failed run waking a later snooze", () => {
  const threadId = ThreadId.make("thread:audit-snooze");
  const createdAt = DateTime.makeUnsafe("2026-08-01T00:00:00.000Z");
  const failedAt = DateTime.makeUnsafe("2026-08-20T00:00:00.000Z");
  const snoozedAt = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
  const snoozedUntil = DateTime.makeUnsafe("2026-09-10T00:00:00.000Z");
  let projection = emptyProjection(
    threadCreatedEvent(makeThread(threadId, createdAt, { snoozedAt, snoozedUntil }), createdAt),
  );
  projection = applyToProjection(projection, {
    id: EventId.make("event:audit-snooze:failed-run"),
    type: "run.created",
    threadId,
    providerInstanceId,
    occurredAt: failedAt,
    payload: {
      id: RunId.make("run:audit-snooze:1"),
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message:audit-snooze:1"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "failed",
      requestedAt: failedAt,
      startedAt: failedAt,
      completedAt: failedAt,
      checkpointId: null,
      contextHandoffId: null,
    },
  });

  assert.strictEqual(
    isAutoSettlementCandidate(
      threadShellFromProjection(projection),
      Date.parse("2026-09-04T00:00:00.000Z"),
    ),
    true,
  );
});

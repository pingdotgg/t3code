import { assert, it } from "../../../apps/server/node_modules/@effect/vitest/dist/index.js";
import {
  EventId,
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
import { shouldAutoSettleThread } from "../../../apps/server/src/orchestration-v2/ThreadSettlementService.ts";
import {
  migrationEntries,
  runMigrations,
} from "../../../apps/server/src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../../../apps/server/src/persistence/NodeSqliteClient.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
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

it.effect("reproduces the old-052 to current-053 migration failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 43 });

    // Current 45-53 are the byte-equivalent old branch 44-52 bodies. Apply
    // them under their old IDs/names to reproduce a database from c1791ab2637.
    for (const [currentId, name, migration] of migrationEntries.filter(([id]) => id >= 45)) {
      yield* migration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${currentId - 1}, ${name})
      `;
    }

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
      assert.match(Cause.pretty(exit.cause), /Migration "53_LegacyV1ImportState" failed/);
      assert.match(Cause.pretty(exit.cause), /already exists/);
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

it.effect("reproduces production root-scope reuse across ordinary runs", () =>
  Effect.gen(function* () {
    const ids = yield* IdAllocatorV2;
    const threadId = ThreadId.make("thread:audit-scope");
    const now = DateTime.makeUnsafe("2026-09-02T00:00:00.000Z");
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

it("confirms closed PR settlement remains active when optional settings are off", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const createdAt = DateTime.makeUnsafe(now - 20 * 60_000);
  const threadId = ThreadId.make("thread:audit-settlement");
  const projection = emptyProjection(
    threadCreatedEvent(makeThread(threadId, createdAt), createdAt),
  );
  const thread = threadShellFromProjection(projection);

  assert.strictEqual(
    shouldAutoSettleThread({
      thread,
      pullRequest: {
        state: "closed",
        updatedAt: "2026-09-02T12:00:00.000Z",
      },
      nowMs: now,
      autoSettleAfterDays: null,
      autoSettleOnMerge: false,
    }),
    true,
  );
});

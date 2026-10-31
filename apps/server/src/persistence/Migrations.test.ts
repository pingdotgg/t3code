import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

it.effect("upgrades startup recovery lookups without changing candidate selection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* runMigrations({ toMigrationInclusive: 75 });

    for (const threadId of [
      "history",
      "active",
      "queued",
      "held",
      "malformed",
      "native",
      "child",
      "wrong-kind",
      "attached-root",
      "deleted",
      "archived",
      "duplicate",
    ]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: threadId,
        project_id: "project",
        title: threadId,
        default_provider: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-10-20",
        updated_at: "2026-10-20",
        deleted_at: threadId === "deleted" ? "2026-10-20" : null,
        archived_at: threadId === "archived" ? "2026-10-20" : null,
        payload_json: "{}",
      })}`;
    }
    for (const [threadId, status, payload] of [
      ["active", "running", '{"queueHeld":true}'],
      ["queued", "queued", "{}"],
      ["held", "queued", '{"queueHeld":true}'],
      ["malformed", "queued", "{"],
      ["deleted", "running", "{}"],
      ["archived", "waiting", "{}"],
      ["duplicate", "running", "{}"],
      ["duplicate", "queued", "{}"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
        run_id: `${threadId}-${status}`,
        thread_id: threadId,
        ordinal: status === "queued" ? 2 : 1,
        provider: "codex",
        status,
        requested_at: "2026-10-20",
        payload_json: payload,
      })}`;
    }
    for (const [id, threadId, origin, status, childThreadId] of [
      ["native-live", "native", "provider_native", "waiting", null],
      ["app-live", "wrong-kind", "app_owned", "running", null],
      ["child-link", "history", "app_owned", "completed", "child"],
      ["wrong-kind-link", "history", "app_owned", "completed", "wrong-kind"],
      ["attached-link", "history", "app_owned", "completed", "attached-root"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_subagents ${sql.insert({
        subagent_id: id,
        thread_id: threadId,
        parent_node_id: "parent",
        provider: "codex",
        origin,
        status,
        child_thread_id: childThreadId,
        updated_at: "2026-10-20",
        payload_json: "{}",
      })}`;
    }
    for (const [threadId, kind, runId] of [
      ["child", "root_turn", null],
      ["wrong-kind", "tool_call", null],
      ["attached-root", "root_turn", "finished-run"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
        node_id: `${threadId}-node`,
        thread_id: threadId,
        run_id: runId,
        root_node_id: `${threadId}-node`,
        kind,
        status: "running",
        payload_json: "{}",
      })}`;
    }

    // Completed records dominate a real database. Their large payloads should
    // not need to be read just to find the few remaining recovery candidates.
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2048)
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      SELECT 'historical-run-' || n, 'history', n, 'codex', 'completed', '2026-10-20',
        json_object('padding', printf('%.*c', 2048, 'x')) FROM history
    `;
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2048)
      INSERT INTO orchestration_v2_projection_nodes
        (node_id, thread_id, root_node_id, kind, status, payload_json)
      SELECT 'historical-node-' || n, 'child', 'child-node', 'tool_call', 'completed',
        json_object('padding', printf('%.*c', 2048, 'x')) FROM history
    `;
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2048)
      INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      SELECT 'historical-subagent-' || n, 'history', 'parent', 'codex',
        'provider_native', 'completed', '2026-10-20',
        json_object('padding', printf('%.*c', 2048, 'x')) FROM history
    `;

    const expected = ["active", "archived", "child", "duplicate", "malformed", "native", "queued"];
    assert.deepStrictEqual((yield* store.getRecoveryThreadIds("runtime")).toSorted(), expected);
    assert.deepStrictEqual(yield* runMigrations(), [[76, "StartupRecoveryIndexes"]]);
    assert.deepStrictEqual(yield* runMigrations(), []);

    const statements: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    const candidates = yield* store.getRecoveryThreadIds("runtime").pipe(Effect.withTracer(tracer));
    assert.deepStrictEqual(candidates.toSorted(), expected);

    const statement = statements.find((query) => query.includes("pending_provider_threads"));
    assert.isDefined(statement);
    const plan = (yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statement}`,
    )).map(({ detail }) => detail);
    const details = plan.join("\n");
    assert.include(details, "orchestration_v2_projection_runs_recovery_idx");
    assert.include(details, "orchestration_v2_projection_nodes_unattached_recovery_idx");
    assert.include(details, "orchestration_v2_projection_subagents_live_native_idx");
    assert.isFalse(
      plan.some((detail) => detail === "SCAN orchestration_v2_projection_runs"),
      details,
    );
    assert.isFalse(
      plan.some((detail) => detail === "SCAN orchestration_v2_projection_subagents"),
      details,
    );
  }).pipe(
    Effect.provide(
      ProjectionStore.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

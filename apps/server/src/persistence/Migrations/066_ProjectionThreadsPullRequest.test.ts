import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const divergentLedgerLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const hasPullRequestColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  return columns.some((column) => column.name === "pull_request_json");
});

const tableExists = Effect.fn("tableExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT count(*) AS count
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ${table}
  `;
  return (rows[0]?.count ?? 0) > 0;
});

layer("066_ProjectionThreadsPullRequest", (it) => {
  it.effect("adds pull_request_json defaulting legacy rows to null without backfill", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 65 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        ) VALUES (
          'thread-legacy',
          'project-1',
          'Legacy',
          '{"model":"gpt","instanceId":"codex"}',
          'full-access',
          'default',
          'feature/shared',
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 66 });

      assert.isTrue(yield* hasPullRequestColumn);

      const rows = yield* sql<{ readonly pullRequestJson: string }>`
        SELECT pull_request_json AS "pullRequestJson"
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `;
      assert.deepStrictEqual(rows, [{ pullRequestJson: "null" }]);
    }),
  );

  it.effect("is safe to replay when the column already exists", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 66 });
      const migration = yield* Effect.promise(
        () => import("./066_ProjectionThreadsPullRequest.ts"),
      );
      yield* migration.default;
      assert.isTrue(yield* hasPullRequestColumn);
    }),
  );
});

divergentLedgerLayer("066_ProjectionThreadsPullRequest divergent ledger", (it) => {
  it.effect("recreates projection_threads when a divergent ledger skipped migration 005", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Advance past 005 so the ledger claims projection core exists.
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* sql`DROP TABLE IF EXISTS projection_threads`;
      assert.isFalse(yield* tableExists("projection_threads"));

      yield* runMigrations({ toMigrationInclusive: 66 });

      assert.isTrue(yield* tableExists("projection_threads"));
      assert.isTrue(yield* hasPullRequestColumn);
    }),
  );
});

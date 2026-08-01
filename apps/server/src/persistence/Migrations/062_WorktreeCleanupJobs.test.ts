import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("062_WorktreeCleanupJobs", (it) => {
  it.effect("creates the cleanup schema when upgrading from released migration 61", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* runMigrations({ toMigrationInclusive: 62 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(worktree_cleanup_jobs)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'worktree_cleanup_jobs'
      `;

      assert.deepStrictEqual(
        columns.map((column) => column.name),
        [
          "thread_id",
          "cwd",
          "worktree_path",
          "requested_at",
          "status",
          "attempt_count",
          "last_error",
        ],
      );
      assert.isTrue(
        indexes.some((index) => index.name === "idx_worktree_cleanup_jobs_pending_path"),
      );
    }),
  );
});

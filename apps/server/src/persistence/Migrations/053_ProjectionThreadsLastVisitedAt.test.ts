import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionThreadsLastVisitedAt", (it) => {
  it.effect("adds last_visited_at and backfills existing threads as read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        ) VALUES (
          'thread-1',
          'project-1',
          'Historical thread',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z'
        )
      `;

      const migrations = yield* runMigrations({ toMigrationInclusive: 53 });
      assert.deepEqual(migrations, [[53, "ProjectionThreadsLastVisitedAt"]]);

      const rows = yield* sql<{ readonly lastVisitedAt: string | null }>`
        SELECT last_visited_at AS "lastVisitedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ lastVisitedAt: "2026-01-02T00:00:00.000Z" }]);

      const rerun = yield* runMigrations({ toMigrationInclusive: 53 });
      assert.deepEqual(rerun, []);
    }),
  );
});

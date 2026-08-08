import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ProjectionThreadsLastViewedAt", (it) => {
  it.effect("starts existing threads read at the upgrade boundary", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          created_at,
          updated_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5.4"}',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const rows = yield* sql<{ readonly lastViewedAt: string | null }>`
        SELECT last_viewed_at AS "lastViewedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(rows.length, 1);
      assert.ok(rows[0]?.lastViewedAt != null);
      assert.ok(Number.isFinite(Date.parse(rows[0].lastViewedAt)));
      assert.ok(rows[0].lastViewedAt > "2026-01-01T00:00:00.000Z");
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

interface SessionRow {
  readonly threadId: string;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly activeTurnId: string | null;
}

const insertSession = Effect.fn("insertSession")(function* (threadId: string, status: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_sessions (
      thread_id,
      status,
      provider_name,
      runtime_mode,
      active_turn_id,
      last_error,
      updated_at
    )
    VALUES (
      ${threadId},
      ${status},
      'claude',
      'full-access',
      'turn-1',
      NULL,
      '2026-03-01T00:00:00.000Z'
    )
  `;
});

const selectSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<SessionRow>`
    SELECT
      thread_id AS "threadId",
      status,
      status_detail AS "statusDetail",
      active_turn_id AS "activeTurnId"
    FROM projection_thread_sessions
    ORDER BY thread_id ASC
  `;
});

it.layer(Layer.fresh(NodeSqliteClient.layerMemory()))(
  "051_ProjectionThreadSessionStatusDetail (existing database)",
  (it) => {
    it.effect("adds the column to a database that already applied 050", () =>
      Effect.gen(function* () {
        // The pull-request link table owns 050 on main, so an installed
        // database can already be at 050 with no status_detail column.
        yield* runMigrations({ toMigrationInclusive: 50 });
        yield* insertSession("thread-running", "running");

        yield* runMigrations({ toMigrationInclusive: 51 });

        assert.deepStrictEqual(yield* selectSessions, [
          {
            threadId: "thread-running",
            status: "running",
            statusDetail: null,
            activeTurnId: "turn-1",
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(NodeSqliteClient.layerMemory()))(
  "051_ProjectionThreadSessionStatusDetail (fresh database)",
  (it) => {
    it.effect("creates a nullable column that round-trips the compaction detail", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();

        yield* insertSession("thread-plain", "running");
        yield* insertSession("thread-compacting", "running");
        yield* sql`
          UPDATE projection_thread_sessions
          SET status_detail = 'compacting'
          WHERE thread_id = 'thread-compacting'
        `;

        assert.deepStrictEqual(yield* selectSessions, [
          {
            threadId: "thread-compacting",
            status: "running",
            statusDetail: "compacting",
            activeTurnId: "turn-1",
          },
          {
            threadId: "thread-plain",
            status: "running",
            statusDetail: null,
            activeTurnId: "turn-1",
          },
        ]);
      }),
    );
  },
);

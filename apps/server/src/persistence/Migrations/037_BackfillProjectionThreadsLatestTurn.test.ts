import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertThread = (input: { readonly threadId: string; readonly latestTurnId: string | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id,
        project_id,
        title,
        latest_turn_id,
        created_at,
        updated_at
      )
      VALUES (
        ${input.threadId},
        'project-backfill',
        ${input.threadId},
        ${input.latestTurnId},
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;
  });

const insertTurn = (input: {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly requestedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id,
        turn_id,
        state,
        requested_at,
        checkpoint_files_json
      )
      VALUES (
        ${input.threadId},
        ${input.turnId},
        'completed',
        ${input.requestedAt},
        '[]'
      )
    `;
  });

layer("037_BackfillProjectionThreadsLatestTurn", (it) => {
  it.effect("points cleared threads back at their most recent real turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

      // Cleared by a turn-end session-set: must be repaired to the newest turn.
      yield* insertThread({ threadId: "thread-cleared", latestTurnId: null });
      yield* insertTurn({
        threadId: "thread-cleared",
        turnId: "turn-old",
        requestedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* insertTurn({
        threadId: "thread-cleared",
        turnId: "turn-new",
        requestedAt: "2026-01-01T00:05:00.000Z",
      });

      // Already pointing at a turn: must not be moved.
      yield* insertThread({ threadId: "thread-kept", latestTurnId: "turn-kept-old" });
      yield* insertTurn({
        threadId: "thread-kept",
        turnId: "turn-kept-old",
        requestedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* insertTurn({
        threadId: "thread-kept",
        turnId: "turn-kept-new",
        requestedAt: "2026-01-01T00:05:00.000Z",
      });

      // Imported transcript turns never became the latest turn on the live
      // path, so the backfill must leave the thread blank rather than invent a
      // completion the user never ran.
      yield* insertThread({ threadId: "thread-imported", latestTurnId: null });
      yield* insertTurn({
        threadId: "thread-imported",
        turnId: "import:transcript-1",
        requestedAt: "2026-01-01T00:05:00.000Z",
      });

      // No turns at all: nothing to point at.
      yield* insertThread({ threadId: "thread-empty", latestTurnId: null });

      yield* runMigrations({ toMigrationInclusive: 37 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly latestTurnId: string | null;
      }>`
        SELECT thread_id AS "threadId", latest_turn_id AS "latestTurnId"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        { threadId: "thread-cleared", latestTurnId: "turn-new" },
        { threadId: "thread-empty", latestTurnId: null },
        { threadId: "thread-imported", latestTurnId: null },
        { threadId: "thread-kept", latestTurnId: "turn-kept-old" },
      ]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const updatedAt = "2026-11-18T10:00:00.000Z";

layer("097_GroupBoard", (it) => {
  it.effect("creates the board table with one topic per title on each lead's board", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      const tables = sql`
        SELECT name FROM sqlite_master
        WHERE tbl_name = 'orchestration_v2_projection_board_topics'
        ORDER BY name
      `;
      assert.deepStrictEqual(yield* tables, []);

      yield* runMigrations({ toMigrationInclusive: 97 });
      assert.deepStrictEqual(
        (yield* tables).map((row) => row.name),
        [
          "orchestration_v2_projection_board_topics",
          "orchestration_v2_projection_board_topics_lead_idx",
          "orchestration_v2_projection_board_topics_title_idx",
          "sqlite_autoindex_orchestration_v2_projection_board_topics_1",
        ],
      );

      const insertTopic = (topicId: string, leadThreadId: string, titleKey: string) =>
        sql`
          INSERT INTO orchestration_v2_projection_board_topics (
            topic_id, lead_thread_id, title_key, order_key, updated_at, payload_json
          ) VALUES (${topicId}, ${leadThreadId}, ${titleKey}, ${updatedAt}, ${updatedAt}, '{}')
        `;
      yield* insertTopic("topic-1", "lead-1", "api shape");
      yield* insertTopic("topic-2", "lead-2", "api shape");
      yield* insertTopic("topic-3", "lead-1", "schema");
      assert.ok(Exit.isFailure(yield* Effect.exit(insertTopic("topic-4", "lead-1", "api shape"))));
    }),
  );
});

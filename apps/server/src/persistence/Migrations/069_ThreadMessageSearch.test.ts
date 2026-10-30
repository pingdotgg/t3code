import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("069_ThreadMessageSearch", (it) => {
  it.effect("backfills what users wrote and agents answered, then follows deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      const insert = (
        id: string,
        role: string,
        streaming: number,
        text: string,
        createdBy: string | undefined = role === "user" ? "user" : "agent",
      ) => sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
        )
        VALUES (
          ${id}, 'thread-1', NULL, NULL, ${role}, ${streaming},
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ${JSON.stringify({ text, createdBy })}
        )
      `;
      yield* insert("user", "user", 0, "needle from the user");
      yield* insert("assistant", "assistant", 0, "needle from the agent");
      yield* insert("streaming", "assistant", 1, "needle still streaming");
      yield* insert("system", "system", 0, "needle in a system prompt");
      yield* insert("notice", "user", 0, "needle in a pull request update", "agent");
      // Older rows carry no author; they were the user's.
      yield* insert("legacy", "user", 0, "needle from before authors", undefined);

      yield* runMigrations();

      const indexed = () =>
        sql<{ readonly messageId: string }>`
          SELECT messages.message_id AS "messageId"
          FROM orchestration_v2_message_search AS search
          INNER JOIN orchestration_v2_projection_messages AS messages
            ON messages.rowid = search.rowid
          WHERE orchestration_v2_message_search MATCH '"needle"'
          ORDER BY messages.message_id
        `.pipe(Effect.map((rows) => rows.map((row) => row.messageId)));
      assert.deepEqual(yield* indexed(), ["assistant", "legacy", "user"]);

      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'user'`;
      assert.deepEqual(yield* indexed(), ["assistant", "legacy"]);
    }),
  );
});

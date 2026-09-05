import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("048_ProjectionMessageComposerRecall", (it) => {
  it.effect("leaves existing message text unchanged and its origin unknown", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      const text = "Ultrathink:\nKeep this prefix in my example";
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('legacy', 'thread', 'user', ${text}, 0, '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`;
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* runMigrations({ toMigrationInclusive: 48 });
      const rows = yield* sql<{
        readonly text: string;
        readonly composer_recall_json: string | null;
      }>`
        SELECT text, composer_recall_json FROM projection_thread_messages WHERE message_id = 'legacy'
      `;
      assert.deepEqual(rows, [{ text, composer_recall_json: null }]);
    }),
  );
});

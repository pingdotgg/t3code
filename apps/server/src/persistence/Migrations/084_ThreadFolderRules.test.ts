import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("084_ThreadFolderRules", (it) => {
  it.effect("keeps existing folder order and marks existing members as placed by hand", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });
      for (const [id, createdAt] of [
        ["newer", "2026-10-02T00:00:00.000Z"],
        ["older", "2026-10-01T00:00:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO thread_folders (folder_id, name, created_at, updated_at)
          VALUES (${id}, ${id}, ${createdAt}, ${createdAt})
        `;
      }
      yield* sql`
        INSERT INTO thread_folder_members (thread_id, folder_id, added_at)
        VALUES ('thread-1', 'older', '2026-10-01T00:00:00.000Z')
      `;

      yield* runMigrations();

      const folders = yield* sql<{ readonly folder_id: string; readonly auto_file: number }>`
        SELECT folder_id, auto_file FROM thread_folders ORDER BY sort_key
      `;
      assert.deepStrictEqual(
        folders.map((folder) => [folder.folder_id, folder.auto_file]),
        [
          ["older", 0],
          ["newer", 0],
        ],
      );
      const explicit = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM thread_folder_explicit_moves
      `;
      assert.deepStrictEqual(
        explicit.map((row) => row.thread_id),
        ["thread-1"],
      );
    }),
  );
});

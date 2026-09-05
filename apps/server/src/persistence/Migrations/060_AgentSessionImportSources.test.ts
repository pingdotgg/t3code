import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("060_AgentSessionImportSources", (it) => {
  it.effect("upgrades migration 59 without changing existing import state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, imported_message_count)
      VALUES ('existing', '2026-01-01', '2026-01-02', 2)`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 60 }), [
        [60, "AgentSessionImportSources"],
      ]);
      const existing =
        yield* sql`SELECT thread_id, imported_message_count FROM orchestration_v2_legacy_imports`;
      assert.deepEqual(existing, [{ thread_id: "existing", imported_message_count: 2 }]);
      yield* sql`INSERT INTO orchestration_v2_agent_session_import_sources (thread_id, file_path, source_json) VALUES ('new', '/session.jsonl', '{}')`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 60 }), []);
    }),
  );
});

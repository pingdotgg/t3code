import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("051_ProjectionThreadSessionAccountRevision", (it) => {
  it.effect("defaults legacy and newly inserted sessions to revision zero", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, provider_instance_id, updated_at)
        VALUES ('legacy', 'ready', 'codex-a', '2026-09-10T00:00:00.000Z')
      `;
      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES ('new', 'ready', '2026-09-10T00:00:00.000Z')
      `;
      const rows = yield* sql<{ readonly owner: string | null; readonly revision: number }>`
        SELECT provider_instance_id AS owner, provider_account_revision AS revision
        FROM projection_thread_sessions ORDER BY thread_id
      `;
      assert.deepEqual(rows, [
        { owner: "codex-a", revision: 0 },
        { owner: null, revision: 0 },
      ]);
    }),
  );
});

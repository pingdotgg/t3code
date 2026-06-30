import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

const layer = it.layer(MigrationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("M3 migrations", (it) => {
  it.effect("creates lease, dispatch outbox, and setup run tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('worktree_lease', 'workflow_dispatch_outbox', 'workflow_setup_run')
      `;
      assert.equal(rows.length, 3);
    }),
  );
});

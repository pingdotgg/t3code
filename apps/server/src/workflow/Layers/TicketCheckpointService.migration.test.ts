import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";

const layer = it.layer(MigrationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("step refs migration", (it) => {
  it.effect("projection_step_run has pre/post ref columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_step_run)`;
      const names = new Set(cols.map((column) => column.name));
      assert.isTrue(names.has("pre_checkpoint_ref"));
      assert.isTrue(names.has("post_checkpoint_ref"));
    }),
  );
});

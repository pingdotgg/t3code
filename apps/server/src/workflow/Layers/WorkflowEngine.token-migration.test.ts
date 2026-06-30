import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

const layer = it.layer(MigrationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("ticket token migration", (it) => {
  it.effect("projection_ticket has current_lane_entry_token", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_ticket)
      `;
      assert.isTrue(columns.some((column) => column.name === "current_lane_entry_token"));
    }),
  );
});

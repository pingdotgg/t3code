import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

layer("Sqlite persistence setup", (it) => {
  it.effect("uses full synchronous durability", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous;`;

      assert.equal(rows[0]?.synchronous, 2);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_AuthSessionClientConnection", (it) => {
  it.effect("adds nullable client surface and app version columns to auth sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(auth_sessions)
      `;
      const surface = columns.find((column) => column.name === "client_surface");
      const appVersion = columns.find((column) => column.name === "client_app_version");

      assert.equal(surface?.name, "client_surface");
      assert.equal(surface?.notnull, 0);
      assert.equal(appVersion?.name, "client_app_version");
      assert.equal(appVersion?.notnull, 0);
    }),
  );
});

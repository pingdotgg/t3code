import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionProjectIcon", (it) => {
  it.effect("adds the nullable project icon JSON to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const projectIcon = columns.find((column) => column.name === "project_icon_json");

      assert.equal(projectIcon?.name, "project_icon_json");
      assert.equal(projectIcon?.notnull, 0);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionProjectKind", (it) => {
  it.effect("adds kind to project projections defaulting to workspace", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '[]',
          '2026-08-13T00:00:00.000Z',
          '2026-08-13T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_projects)
      `;
      const kind = columns.find((column) => column.name === "kind");
      assert.equal(kind?.name, "kind");
      assert.equal(kind?.notnull, 1);

      const rows = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.equal(rows[0]?.kind, "workspace");
    }),
  );
});

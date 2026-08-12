import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("multi-repository projection columns", (it) => {
  it.effect("adds the project roots, workspace file, and thread worktree columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const projectColumns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_projects)`;
      const threadColumns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_threads)`;

      assert.equal(projectColumns.find((column) => column.name === "repo_roots")?.notnull, 1);
      assert.equal(projectColumns.find((column) => column.name === "workspace_file")?.notnull, 0);
      assert.equal(threadColumns.find((column) => column.name === "worktrees_json")?.notnull, 1);
    }),
  );
});

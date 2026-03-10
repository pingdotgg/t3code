import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0014 from "./014_ProjectionProjectsThreadGroupOrder.ts";

const layer = it.layer(SqliteClient.layerMemory());

const baseProjectionProjectsSchema = `
  CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    default_model TEXT,
    scripts_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`;

const projectionProjectsSchemaWithThreadGroupOrder = `
  CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    default_model TEXT,
    scripts_json TEXT NOT NULL,
    thread_group_order_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`;

layer("014_ProjectionProjectsThreadGroupOrder", (it) => {
  it.effect("adds thread_group_order_json when the column is missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DROP TABLE IF EXISTS projection_projects`;
      yield* sql.unsafe(baseProjectionProjectsSchema);
      yield* Migration0014;

      const columns = yield* sql`PRAGMA table_info(projection_projects)`.values;
      assert.deepStrictEqual(
        columns.map((column) => column[1]),
        [
          "project_id",
          "title",
          "workspace_root",
          "default_model",
          "scripts_json",
          "created_at",
          "updated_at",
          "deleted_at",
          "thread_group_order_json",
        ],
      );
    }),
  );

  it.effect("does not fail when the column already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DROP TABLE IF EXISTS projection_projects`;
      yield* sql.unsafe(projectionProjectsSchemaWithThreadGroupOrder);
      yield* Migration0014;

      const columns = yield* sql`PRAGMA table_info(projection_projects)`.values;
      assert.deepStrictEqual(
        columns.filter((column) => column[1] === "thread_group_order_json").length,
        1,
      );
    }),
  );
});

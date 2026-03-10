import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0015 from "./015_ProjectionProjectsSortOrder.ts";

const layer = it.layer(SqliteClient.layerMemory());

const baseProjectionProjectsSchema = `
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

const projectionProjectsSchemaWithSortOrder = `
  CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    default_model TEXT,
    scripts_json TEXT NOT NULL,
    thread_group_order_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`;

layer("015_ProjectionProjectsSortOrder", (it) => {
  it.effect("adds sort_order when the column is missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DROP TABLE IF EXISTS projection_projects`;
      yield* sql.unsafe(baseProjectionProjectsSchema);
      yield* Migration0015;

      const columns = yield* sql`PRAGMA table_info(projection_projects)`.values;
      assert.deepStrictEqual(
        columns.map((column) => column[1]),
        [
          "project_id",
          "title",
          "workspace_root",
          "default_model",
          "scripts_json",
          "thread_group_order_json",
          "created_at",
          "updated_at",
          "deleted_at",
          "sort_order",
        ],
      );
    }),
  );

  it.effect("does not fail when the column already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DROP TABLE IF EXISTS projection_projects`;
      yield* sql.unsafe(projectionProjectsSchemaWithSortOrder);
      yield* Migration0015;

      const columns = yield* sql`PRAGMA table_info(projection_projects)`.values;
      assert.deepStrictEqual(columns.filter((column) => column[1] === "sort_order").length, 1);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0016 from "./016_ProjectionThreadsSidebarState.ts";

const layer = it.layer(SqliteClient.layerMemory());

const baseProjectionThreadsSchema = `
  CREATE TABLE projection_threads (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    runtime_mode TEXT NOT NULL DEFAULT 'full-access',
    interaction_mode TEXT NOT NULL DEFAULT 'default',
    branch TEXT,
    worktree_path TEXT,
    latest_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`;

const projectionThreadsSchemaWithSidebarState = `
  CREATE TABLE projection_threads (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    runtime_mode TEXT NOT NULL DEFAULT 'full-access',
    interaction_mode TEXT NOT NULL DEFAULT 'default',
    branch TEXT,
    worktree_path TEXT,
    sidebar_hidden_at TEXT,
    dismissed_sidebar_keys_json TEXT NOT NULL DEFAULT '[]',
    latest_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`;

layer("016_ProjectionThreadsSidebarState", (it) => {
  it.effect("adds sidebar state columns when they are missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DROP TABLE IF EXISTS projection_threads`;
      yield* sql.unsafe(baseProjectionThreadsSchema);
      yield* Migration0016;

      const columns = yield* sql`PRAGMA table_info(projection_threads)`.values;
      assert.deepStrictEqual(
        columns.map((column) => column[1]),
        [
          "thread_id",
          "project_id",
          "title",
          "model",
          "runtime_mode",
          "interaction_mode",
          "branch",
          "worktree_path",
          "latest_turn_id",
          "created_at",
          "updated_at",
          "deleted_at",
          "sidebar_hidden_at",
          "dismissed_sidebar_keys_json",
        ],
      );
    }),
  );

  it.effect("does not fail when the sidebar state columns already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DROP TABLE IF EXISTS projection_threads`;
      yield* sql.unsafe(projectionThreadsSchemaWithSidebarState);
      yield* Migration0016;

      const columns = yield* sql`PRAGMA table_info(projection_threads)`.values;
      assert.deepStrictEqual(columns.filter((column) => column[1] === "sidebar_hidden_at").length, 1);
      assert.deepStrictEqual(
        columns.filter((column) => column[1] === "dismissed_sidebar_keys_json").length,
        1,
      );
    }),
  );
});

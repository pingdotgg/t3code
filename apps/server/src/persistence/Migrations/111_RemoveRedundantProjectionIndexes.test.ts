import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("keeps covering indexes and removes their strict prefixes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();

    const rows = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name LIKE 'idx_projection_%'
    `;
    const indexes = new Set(rows.map((row) => row.name));

    for (const removed of [
      "idx_projection_threads_project_id",
      "idx_projection_thread_activities_thread_created",
    ]) {
      assert.isFalse(indexes.has(removed), removed);
    }
    for (const covering of [
      "idx_projection_threads_project_deleted_created",
      "idx_projection_thread_activities_thread_chronology",
    ]) {
      assert.isTrue(indexes.has(covering), covering);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

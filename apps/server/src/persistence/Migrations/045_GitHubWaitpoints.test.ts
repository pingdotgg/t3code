import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("installs fenced durable GitHub waitpoints", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* runMigrations({ toMigrationInclusive: 45 });

    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(github_waitpoints)
    `;
    assert.deepStrictEqual(
      columns.map(({ name }) => name),
      [
        "waitpoint_id",
        "project_id",
        "thread_id",
        "originating_run_id",
        "repository",
        "pull_request_number",
        "condition",
        "baseline_json",
        "continuation_prompt",
        "delivery_prompt",
        "state",
        "next_poll_at",
        "deadline_at",
        "delivery_lease_token",
        "delivery_lease_expires_at",
        "attempt_count",
        "last_error",
        "created_at",
        "updated_at",
        "completed_at",
      ],
    );

    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'github_waitpoints'
      ORDER BY name
    `;
    assert.ok(indexes.some(({ name }) => name === "idx_github_waitpoints_due"));
    assert.ok(indexes.some(({ name }) => name === "idx_github_waitpoints_thread"));
  }).pipe(Effect.provide(Layer.mergeAll(NodeSqliteClient.layerMemory()))),
);

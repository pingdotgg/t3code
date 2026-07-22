import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_GitHubWaitpoints", (it) => {
  it.effect("installs durable GitHub waitpoint storage and its due-work index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* runMigrations({ toMigrationInclusive: 34 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(github_waitpoints)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(github_waitpoints)
      `;

      assert.deepStrictEqual(
        columns.map((column) => column.name),
        [
          "id",
          "thread_id",
          "originating_turn_id",
          "repository",
          "pull_request_number",
          "condition",
          "baseline_json",
          "continuation_prompt",
          "state",
          "next_poll_at",
          "deadline_at",
          "delivery_lease_expires_at",
          "attempt_count",
          "last_error",
          "created_at",
          "updated_at",
          "delivered_at",
        ],
      );
      assert.ok(indexes.some((index) => index.name === "idx_github_waitpoints_due"));
    }),
  );
});

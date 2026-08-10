import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_AgentRuns", (it) => {
  it.effect("creates content-addressed profile snapshots and the Agent run projection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const tableNames = new Set(tables.map(({ name }) => name));
      assert.ok(tableNames.has("agent_profile_snapshots"));
      assert.ok(tableNames.has("projection_agent_runs"));
      assert.ok(tableNames.has("agent_run_events"));

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_agent_runs)
      `;
      const columnNames = new Set(columns.map(({ name }) => name));
      for (const expected of [
        "agent_run_id",
        "root_run_id",
        "parent_thread_id",
        "child_thread_id",
        "profile_revision",
        "provider_instance_id",
        "model_selection_json",
        "budget_json",
        "result_json",
        "revision",
        "usage_json",
        "waiting_for_children",
      ]) {
        assert.ok(columnNames.has(expected), `missing ${expected}`);
      }

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_agent_runs)
      `;
      const indexNames = new Set(indexes.map(({ name }) => name));
      assert.ok(indexNames.has("idx_projection_agent_runs_parent"));
      assert.ok(indexNames.has("idx_projection_agent_runs_lineage"));
      assert.ok(indexNames.has("idx_projection_agent_runs_root"));
      assert.ok(indexNames.has("idx_projection_agent_runs_child_thread"));

      const eventIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(agent_run_events)
      `;
      assert.ok(eventIndexes.some(({ name }) => name === "idx_agent_run_events_run_revision"));
    }),
  );
});

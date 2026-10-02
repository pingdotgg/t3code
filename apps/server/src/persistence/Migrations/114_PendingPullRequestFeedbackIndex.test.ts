import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("indexes only monitors with pending feedback for bounded delivery scans", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 113 });
    yield* runMigrations({ toMigrationInclusive: 114 });

    const indexes = yield* sql<{ readonly name: string; readonly sql: string | null }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'pull_request_monitor_feedback_state'
    `;
    const pendingIndex = indexes.find(
      ({ name }) => name === "idx_pr_monitor_feedback_state_pending",
    );
    assert.isDefined(pendingIndex);
    assert.include(pendingIndex!.sql ?? "", "WHERE pending_revision_ids_json <> '[]'");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

import * as Migrator from "@effect/sql/Migrator";
import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

const ORCHESTRATION_MIGRATIONS = Migrator.fromRecord({
  "0001_create_orchestration_events": Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS orchestration_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          command_id TEXT,
          payload_json TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_orch_events_aggregate
        ON orchestration_events(aggregate_type, aggregate_id, sequence)
      `;
    }),
  ),
});

export const runOrchestrationMigrations = Migrator.make({})({
  loader: ORCHESTRATION_MIGRATIONS,
  table: "orchestration_sql_migrations",
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionSyncedClientPreferences", (it) => {
  it.effect("creates the projection and seeds its cursor at the existing event-log head", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO orchestration_events (
          sequence,
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          7,
          'event-before-synced-preferences-projector',
          'project',
          'project-existing',
          1,
          'project.created',
          '2026-08-14T12:00:00.000Z',
          'client',
          '{}',
          '{}'
        )
      `;
      yield* sql`
        CREATE TABLE projection_synced_client_preferences (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          plan_mode_enabled INTEGER,
          plan_mode_enabled_updated_at TEXT,
          appearance_mode TEXT,
          appearance_mode_updated_at TEXT,
          theme_id TEXT,
          theme_id_updated_at TEXT,
          updated_at TEXT NOT NULL
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_synced_client_preferences)
      `;
      const rows = yield* sql<Record<string, unknown>>`
        SELECT * FROM projection_synced_client_preferences
      `;
      const projectorState = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.synced-client-preferences'
      `;

      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "singleton_id",
          "plan_mode_enabled",
          "plan_mode_enabled_updated_at",
          "appearance_mode",
          "appearance_mode_updated_at",
          "theme_id",
          "theme_id_updated_at",
          "updated_at",
        ],
      );
      assert.deepEqual(rows, []);
      assert.deepEqual(projectorState, [
        {
          projector: "projection.synced-client-preferences",
          lastAppliedSequence: 7,
        },
      ]);
      assert.deepEqual(migrationManifest.at(-1), [41, "ProjectionSyncedClientPreferences"]);
    }),
  );
});

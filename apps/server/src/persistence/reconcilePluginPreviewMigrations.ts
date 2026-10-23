import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import WebhookDedupe from "./Migrations/067_WebhookDedupe.ts";
import ShellStopRequestIndex from "./Migrations/068_ShellStopRequestIndex.ts";

// These unmerged preview builds used main's next slots. Recognize their exact
// histories and schemas; never reinterpret an unknown build's migration ledger.
const legacyNames = ["PluginInstallations", "PluginEventCursors", "PluginSettings"] as const;
const legacySchemas = [
  [
    [
      "plugin_installations",
      "CREATE TABLE plugin_installations ( installation_id TEXT PRIMARY KEY, directory TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL )",
    ],
  ],
  [
    [
      "plugin_event_cursors",
      "CREATE TABLE plugin_event_cursors ( installation_id TEXT PRIMARY KEY, acknowledged_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL )",
    ],
  ],
  [
    [
      "plugin_settings",
      "CREATE TABLE plugin_settings ( installation_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY (installation_id, key) )",
    ],
    [
      "plugin_setting_secrets",
      "CREATE TABLE plugin_setting_secrets ( installation_id TEXT NOT NULL, key TEXT NOT NULL, saved INTEGER NOT NULL, PRIMARY KEY (installation_id, key) )",
    ],
    [
      "plugin_storage",
      "CREATE TABLE plugin_storage ( installation_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (installation_id, key) )",
    ],
  ],
] as const;
const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ").toLowerCase();
const badState = () =>
  new Migrator.MigrationError({
    kind: "BadState",
    message: "Cannot upgrade an unknown or ambiguous plugin preview migration history/schema.",
  });

export const reconcilePluginPreviewMigrations = Effect.fn("reconcilePluginPreviewMigrations")(
  function* (manifest: ReadonlyArray<readonly [number, string]>, throughId?: number) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const exists =
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`;
        if (exists.length === 0) return [];
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
        const tail = history.filter((row) => row.migration_id >= 67);
        if (
          !tail.some(
            (row) =>
              legacyNames.includes(row.name as (typeof legacyNames)[number]) &&
              row.migration_id < 69,
          )
        )
          return [];
        const available = legacyNames.filter((name, offset) =>
          manifest.some(([id, found]) => id === 69 + offset && found === name),
        );
        if (
          tail.length === 0 ||
          tail.length > available.length ||
          tail.some(
            (row, offset) => row.migration_id !== 67 + offset || row.name !== available[offset],
          ) ||
          (throughId !== undefined && throughId < 68 + tail.length)
        )
          return yield* badState();
        const earlier = history.filter((row) => row.migration_id < 67);
        const expected = manifest.filter(([id]) => id < 67);
        if (
          earlier.length !== expected.length ||
          earlier.some(
            (row, offset) =>
              row.migration_id !== expected[offset]?.[0] || row.name !== expected[offset]?.[1],
          )
        )
          return yield* badState();
        const schema = yield* sql<{
          readonly name: string;
          readonly tbl_name: string;
          readonly sql: string | null;
        }>`SELECT name, tbl_name, sql FROM sqlite_master`;
        for (const [offset, tables] of legacySchemas.entries()) {
          for (const [name, definition] of tables) {
            const objects = schema.filter((row) => row.tbl_name === name && row.sql !== null);
            if (offset < tail.length) {
              if (
                objects.length !== 1 ||
                objects[0]?.name !== name ||
                normalize(objects[0].sql!) !== normalize(definition)
              )
                return yield* badState();
            } else if (objects.length !== 0) return yield* badState();
          }
        }
        const taskColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(scheduled_tasks)`;
        if (
          taskColumns.some((row) => row.name === "last_run_webhook_delivery_id") ||
          schema.some((row) =>
            [
              "scheduled_task_webhook_replay_keys",
              "scheduled_task_webhook_pending",
              "orchestration_v2_projection_turn_items_stop_request_idx",
            ].includes(row.name),
          )
        )
          return yield* badState();
        // Descending moves free 69 before moving 67 there, preserving timestamps.
        for (let offset = tail.length - 1; offset >= 0; offset--) {
          yield* sql`UPDATE effect_sql_migrations SET migration_id = ${69 + offset} WHERE migration_id = ${67 + offset} AND name = ${legacyNames[offset]}`;
        }
        yield* WebhookDedupe;
        yield* ShellStopRequestIndex;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (67, 'WebhookDedupe'), (68, 'ShellStopRequestIndex')`;
        return [
          [67, "WebhookDedupe"],
          [68, "ShellStopRequestIndex"],
        ] as const;
      }),
    );
  },
);

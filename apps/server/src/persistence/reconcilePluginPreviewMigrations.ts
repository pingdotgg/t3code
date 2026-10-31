import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import WebhookDedupe from "./Migrations/067_WebhookDedupe.ts";
import ShellStopRequestIndex from "./Migrations/068_ShellStopRequestIndex.ts";
import Migration69 from "./Migrations/069_ThreadMessageSearch.ts";
import Migration70 from "./Migrations/070_PeerLinks.ts";
import Migration71 from "./Migrations/071_PeerLinkFence.ts";
import Migration72 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Migration73 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import Migration74 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import Migration75 from "./Migrations/075_SubagentDeliveryState.ts";
import Migration76 from "./Migrations/076_ProjectionProjectsPinArchive.ts";

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
const upstream = [
  [67, "WebhookDedupe", WebhookDedupe],
  [68, "ShellStopRequestIndex", ShellStopRequestIndex],
  [69, "ThreadMessageSearch", Migration69],
  [70, "PeerLinks", Migration70],
  [71, "PeerLinkFence", Migration71],
  [72, "WaitingLinkRequestIndex", Migration72],
  [73, "ActiveTurnItemIndexes", Migration73],
  [74, "ExcludeAttachmentPlaceholdersFromSearch", Migration74],
  [75, "SubagentDeliveryState", Migration75],
  [76, "ProjectionProjectsPinArchive", Migration76],
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
        const preview = history.find(
          (row) => row.name === legacyNames[0] && [67, 69, 76].includes(row.migration_id),
        );
        if (!preview) return [];
        const start = preview.migration_id;
        const canonical = manifest.find(([, name]) => name === legacyNames[0])?.[0];
        if (canonical === undefined) return yield* badState();
        const tail = history.filter((row) => row.migration_id >= start);
        const available = legacyNames.filter((name, offset) =>
          manifest.some(([id, found]) => id === canonical + offset && found === name),
        );
        if (
          tail.length === 0 ||
          tail.length > available.length ||
          tail.some(
            (row, offset) => row.migration_id !== start + offset || row.name !== available[offset],
          ) ||
          (throughId !== undefined && throughId < canonical + tail.length - 1)
        )
          return yield* badState();
        const earlier = history.filter((row) => row.migration_id < start);
        const expected = manifest.filter(([id]) => id < start);
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
        if (
          start < 76 &&
          schema.some((row) =>
            [
              "orchestration_v2_message_search",
              "peer_environment_links",
              "orchestration_v2_projection_turn_items_waiting_link_idx",
              "orchestration_v2_projection_turn_items_active_ordinal_idx",
              "orchestration_v2_projection_turn_items_active_run_idx",
              "orchestration_v2_projection_subagents_settled_idx",
            ].includes(row.name),
          )
        )
          return yield* badState();
        const subagentColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(orchestration_v2_projection_subagents)`;
        if (start < 76 && subagentColumns.some((row) => row.name === "completion_delivery_state"))
          return yield* badState();
        const projectColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_projects)`;
        if (projectColumns.some((row) => row.name === "pinned_at" || row.name === "archived_at"))
          return yield* badState();
        const taskColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(scheduled_tasks)`;
        if (
          start === 67 &&
          (taskColumns.some((row) => row.name === "last_run_webhook_delivery_id") ||
            schema.some((row) =>
              [
                "scheduled_task_webhook_replay_keys",
                "scheduled_task_webhook_pending",
                "orchestration_v2_projection_turn_items_stop_request_idx",
              ].includes(row.name),
            ))
        )
          return yield* badState();
        // Move the preview ledger before filling main's slots; the transaction preserves both on failure.
        for (let offset = tail.length - 1; offset >= 0; offset--) {
          yield* sql`UPDATE effect_sql_migrations SET migration_id = ${canonical + offset} WHERE migration_id = ${start + offset} AND name = ${legacyNames[offset]}`;
        }
        const executed: Array<readonly [number, string]> = [];
        for (const [id, name, migration] of upstream) {
          if (id < start) continue;
          yield* migration;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
          executed.push([id, name]);
        }
        return executed;
      }),
    );
  },
);

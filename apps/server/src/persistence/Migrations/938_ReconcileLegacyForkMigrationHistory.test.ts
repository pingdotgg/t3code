import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0938 from "./938_ReconcileLegacyForkMigrationHistory.ts";

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const currentLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const legacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshLayer("938_ReconcileLegacyForkMigrationHistory fresh database", (it) => {
  it.effect("is safe on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const migration = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM effect_sql_migrations
        WHERE migration_id = 938
      `;
      assert.deepStrictEqual(migration, [{ name: "ReconcileLegacyForkMigrationHistory" }]);
    }),
  );
});

currentLayer("938_ReconcileLegacyForkMigrationHistory current database", (it) => {
  it.effect("preserves auth state when the scoped schema is already current", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 937 });
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, scopes, subject, created_at, expires_at
        )
        VALUES (
          'current-link',
          'current-credential',
          'direct',
          '["orchestration:read"]',
          'current-client',
          '2026-07-29T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, scopes, method, issued_at, expires_at
        )
        VALUES (
          'current-session',
          'current-client',
          '["orchestration:read"]',
          'pairing',
          '2026-07-29T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z'
        )
      `;

      yield* Migration0938;

      const pairingLinks = yield* sql<{ readonly id: string }>`
        SELECT id FROM auth_pairing_links
      `;
      const sessions = yield* sql<{ readonly sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions
      `;
      assert.deepStrictEqual(pairingLinks, [{ id: "current-link" }]);
      assert.deepStrictEqual(sessions, [{ sessionId: "current-session" }]);
    }),
  );
});

legacyLayer("938_ReconcileLegacyForkMigrationHistory legacy fork database", (it) => {
  it.effect("repairs the schema and normalizes mobile-visible Ask state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 25 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        )
        VALUES (
          'legacy-project',
          'Legacy',
          '/tmp/legacy',
          '{"provider":"codex","model":"gpt-5.4","options":{"reasoningEffort":"high"}}',
          '[]',
          '2026-07-29T00:00:00.000Z',
          '2026-07-29T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, branch,
          worktree_path, latest_turn_id, created_at, updated_at, archived_at,
          latest_user_message_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, deleted_at,
          runtime_mode, interaction_mode
        )
        VALUES (
          'legacy-thread',
          'legacy-project',
          'Legacy Ask',
          '{"provider":"codex","model":"gpt-5.4","options":{"reasoningEffort":"high"}}',
          NULL, NULL, NULL,
          '2026-07-29T00:00:00.000Z',
          '2026-07-29T00:00:00.000Z',
          NULL, NULL, 0, 0, 0, NULL,
          'full-access',
          'ask'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        )
        VALUES (
          'legacy-event',
          'thread',
          'legacy-thread',
          1,
          'thread.created',
          '2026-07-29T00:00:00.000Z',
          'legacy-command',
          NULL,
          'legacy-correlation',
          'user',
          '{"threadId":"legacy-thread","interactionMode":"ask","modelSelection":{"provider":"codex","model":"gpt-5.4","options":{"reasoningEffort":"high"}}}',
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, role, subject, created_at, expires_at
        )
        VALUES (
          'legacy-link',
          'legacy-credential',
          'direct',
          'owner',
          'legacy-client',
          '2026-07-29T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z'
        )
      `;

      yield* Migration0938;

      const thread = yield* sql<{
        readonly interactionMode: string;
        readonly optionId: string;
        readonly optionValue: string;
      }>`
        SELECT
          interaction_mode AS "interactionMode",
          json_extract(model_selection_json, '$.options[0].id') AS "optionId",
          json_extract(model_selection_json, '$.options[0].value') AS "optionValue"
        FROM projection_threads
        WHERE thread_id = 'legacy-thread'
      `;
      const event = yield* sql<{
        readonly interactionMode: string;
        readonly optionId: string;
        readonly optionValue: string;
      }>`
        SELECT
          json_extract(payload_json, '$.interactionMode') AS "interactionMode",
          json_extract(payload_json, '$.modelSelection.options[0].id') AS "optionId",
          json_extract(payload_json, '$.modelSelection.options[0].value') AS "optionValue"
        FROM orchestration_events
        WHERE event_id = 'legacy-event'
      `;
      const providerColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_session_runtime)
      `;
      const threadSessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      const pairingLinks = yield* sql<{ readonly id: string }>`
        SELECT id FROM auth_pairing_links
      `;

      assert.strictEqual(thread[0]?.interactionMode, "default");
      assert.strictEqual(thread[0]?.optionId, "reasoningEffort");
      assert.strictEqual(thread[0]?.optionValue, "high");
      assert.strictEqual(event[0]?.interactionMode, "default");
      assert.strictEqual(event[0]?.optionId, "reasoningEffort");
      assert.strictEqual(event[0]?.optionValue, "high");
      assert.isTrue(providerColumns.some((column) => column.name === "provider_instance_id"));
      assert.isTrue(threadSessionColumns.some((column) => column.name === "provider_instance_id"));
      assert.isTrue(pairingColumns.some((column) => column.name === "scopes"));
      assert.isTrue(pairingColumns.some((column) => column.name === "proof_key_thumbprint"));
      assert.deepStrictEqual(pairingLinks, []);
    }),
  );
});

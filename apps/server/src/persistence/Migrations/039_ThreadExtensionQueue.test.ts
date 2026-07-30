import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0039 from "./039_ThreadExtensionQueue.ts";

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const legacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshLayer("039_ThreadExtensionQueue fresh database", (it) => {
  it.effect("creates isolated extension state without widening threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const queueColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_turn_queue)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      assert.isTrue(queueColumns.some((column) => column.name === "ask_override"));
      assert.isFalse(threadColumns.some((column) => column.name === "queue_status"));
      assert.isFalse(threadColumns.some((column) => column.name === "ask_override"));
    }),
  );
});

legacyLayer("039_ThreadExtensionQueue legacy queue", (it) => {
  it.effect("canonicalizes Ask and restores legacy work paused", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        CREATE TABLE projection_thread_turn_queue (
          thread_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          text TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL,
          model_selection_json TEXT NOT NULL,
          runtime_mode TEXT NOT NULL,
          interaction_mode TEXT NOT NULL,
          title_seed TEXT,
          source_proposed_plan_thread_id TEXT,
          source_proposed_plan_id TEXT,
          queued_at TEXT NOT NULL,
          enqueue_sequence INTEGER NOT NULL,
          PRIMARY KEY (thread_id, message_id)
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_turn_queue (
          thread_id, message_id, text, attachment_ids_json, model_selection_json,
          runtime_mode, interaction_mode, title_seed, source_proposed_plan_thread_id,
          source_proposed_plan_id, queued_at, enqueue_sequence
        )
        VALUES (
          'thread-1', 'message-1', 'queued', '[]',
          '{"provider":"codex","model":"gpt-5.4","options":{"reasoningEffort":"high"}}',
          'full-access', 'ask', NULL, NULL, NULL, '2026-07-29T00:00:00.000Z', 1
        )
      `;

      yield* Migration0039;

      const queue = yield* sql<{
        readonly interactionMode: string;
        readonly askOverride: number;
        readonly optionId: string;
      }>`
        SELECT
          interaction_mode AS "interactionMode",
          ask_override AS "askOverride",
          json_extract(model_selection_json, '$.options[0].id') AS "optionId"
        FROM projection_thread_turn_queue
      `;
      const extension = yield* sql<{
        readonly status: string;
        readonly reason: string;
      }>`
        SELECT queue_status AS status, queue_pause_reason AS reason
        FROM thread_extension_state
        WHERE thread_id = 'thread-1'
      `;

      assert.deepStrictEqual(queue, [
        { interactionMode: "default", askOverride: 1, optionId: "reasoningEffort" },
      ]);
      assert.deepStrictEqual(extension, [{ status: "paused", reason: "migration" }]);
    }),
  );
});

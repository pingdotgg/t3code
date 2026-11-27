import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  DEFERRED_COMMAND_MESSAGE_CONDITION,
  JAVASCRIPT_TRIM_WHITESPACE,
} from "../../orchestration-v2/deferredCommandMessage.ts";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("100_TurnStartReadIndexes", (it) => {
  it.effect("keeps a user message with a malformed payload migratable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 99 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, role, streaming, created_at, updated_at, payload_json
        )
        VALUES
          (
            'malformed', 'thread-1', 'user', 0,
            '2026-11-14T00:00:00.000Z', '2026-11-14T00:00:00.000Z', '{not json'
          ),
          (
            'valid-slash', 'thread-1', 'user', 0,
            '2026-11-14T00:01:00.000Z', '2026-11-14T00:01:00.000Z', '{"text":"/compact"}'
          )
      `;
      yield* runMigrations();

      const deferred = yield* sql<{ readonly message_id: string }>`
        SELECT message_id
        FROM orchestration_v2_projection_messages
        WHERE thread_id = 'thread-1' AND ${sql.literal(DEFERRED_COMMAND_MESSAGE_CONDITION)}
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(
        deferred.map((row) => row.message_id),
        ["valid-slash"],
      );
    }),
  );

  it.effect("uses the legacy unguarded partial index on an already-migrated database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DROP INDEX orchestration_v2_projection_messages_deferred_command_idx`;
      yield* sql.unsafe(`
        CREATE INDEX orchestration_v2_projection_messages_deferred_command_idx
        ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
        WHERE role = 'user' AND trim(json_extract(payload_json, '$.text'), '${JAVASCRIPT_TRIM_WHITESPACE}') GLOB '/*'
      `);

      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN
          SELECT payload_json, created_at, message_id
          FROM orchestration_v2_projection_messages
          WHERE thread_id = ? AND ${DEFERRED_COMMAND_MESSAGE_CONDITION}`,
        ["thread-1"],
      );
      assert.isTrue(
        plan.some((row) =>
          row.detail.includes("orchestration_v2_projection_messages_deferred_command_idx"),
        ),
        `Expected query plan to use legacy partial index, got: ${JSON.stringify(plan)}`,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

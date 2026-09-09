import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import migrateClientSettlements from "./050_RepairClientSettlementTimestamps.ts";

it.layer(NodeSqliteClient.layerMemory())("050_RepairClientSettlementTimestamps", (it) => {
  it.effect("repairs legacy sweeps after 046 without rewriting manual or newer settlements", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });
      const createdAt = "2026-04-14T00:00:00.000Z";
      const messageAt = "2026-04-14T13:21:02.000Z";
      const requestedAt = "2026-07-01T14:55:00.000Z";
      const startedAt = "2026-07-01T14:56:00.000Z";
      const completedAt = "2026-07-01T14:56:47.000Z";
      const laterAt = "2026-09-08T00:00:00.000Z";
      const expected = new Map<string, string | null>();

      const cohorts = [
        { name: "sweep", at: "2026-09-04T13:33:00.000Z", count: 34 },
        { name: "manual", at: "2026-09-03T00:00:00.000Z", count: 1 },
        { name: "small", at: "2026-09-03T01:00:00.000Z", count: 9 },
        { name: "slow", at: "2026-09-03T02:00:00.000Z", count: 10 },
        { name: "repeated", at: "2026-09-03T03:00:00.000Z", count: 10 },
        { name: "boundary", at: "2026-09-03T04:00:00.000Z", count: 10 },
        { name: "new-client", at: "2026-09-04T13:33:00.000Z", count: 10 },
        { name: "no-origin", at: "2026-09-04T13:33:00.000Z", count: 10 },
        { name: "late", at: "2026-09-05T00:00:00.000Z", count: 10 },
      ];
      for (const [cohortIndex, cohort] of cohorts.entries()) {
        for (let index = 0; index < cohort.count; index++) {
          const threadId = `${cohort.name}-${cohort.name === "repeated" ? 0 : index}`;
          const occurredAt = DateTime.makeUnsafe(cohort.at).pipe(
            DateTime.add({
              milliseconds:
                cohort.name === "boundary" && index === 9
                  ? 120_000
                  : index * (cohort.name === "slow" ? 20_000 : 2_500),
            }),
            DateTime.formatIso,
          );
          const appVersion = cohort.name === "new-client" ? "0.0.40" : `0.0.${35 + (index % 4)}`;
          if (cohort.name !== "repeated" || index === 0) {
            yield* sql`
              INSERT INTO projection_threads (
                thread_id, project_id, title, model_selection_json,
                created_at, updated_at, settled_override, settled_at
              ) VALUES (
                ${threadId}, ${`project-${index % 3}`}, ${threadId},
                '{"instanceId":"codex","model":"gpt-5.6-sol"}',
                ${createdAt}, ${occurredAt}, 'settled', ${occurredAt}
              )
            `;
            expected.set(
              threadId,
              cohort.name === "sweep" || cohort.name === "boundary" ? createdAt : occurredAt,
            );
          }
          const commandId = `00000000-0000-4000-8000-${String(cohortIndex * 100 + index).padStart(12, "0")}`;
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, correlation_id, actor_kind, payload_json, metadata_json
            ) VALUES (
              ${`event-${commandId}`}, 'thread', ${threadId}, ${index}, 'thread.settled', ${occurredAt},
              ${commandId}, ${commandId}, 'client',
              json_object('threadId', ${threadId}, 'settledAt', ${occurredAt}, 'updatedAt', ${occurredAt}),
              CASE WHEN ${cohort.name} = 'no-origin' THEN '{}'
                ELSE json_object('origin', json_object('appVersion', ${appVersion})) END
            )
          `;
        }
      }

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('user', 'sweep-1', 'user', 'Prompt', 0, ${messageAt}, ${messageAt}),
          ('assistant', 'sweep-1', 'assistant', 'Reply', 0, ${completedAt}, ${completedAt}),
          ('later', 'sweep-1', 'user', 'Later prompt', 0, ${laterAt}, ${laterAt}),
          ('invalid', 'sweep-1', 'user', 'Invalid date', 0, 'invalid', 'invalid')
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json
        ) VALUES
          ('sweep-2', 'requested', 'pending', ${requestedAt}, NULL, NULL, '[]'),
          ('sweep-3', 'started', 'running', ${requestedAt}, ${startedAt}, NULL, '[]'),
          ('sweep-4', 'completed', 'completed', ${requestedAt}, ${startedAt}, ${completedAt}, '[]'),
          ('sweep-4', 'later', 'completed', ${laterAt}, ${laterAt}, ${laterAt}, '[]')
      `;
      expected.set("sweep-1", messageAt);
      expected.set("sweep-2", requestedAt);
      expected.set("sweep-3", startedAt);
      expected.set("sweep-4", completedAt);
      yield* sql`UPDATE projection_threads SET settled_at = ${laterAt} WHERE thread_id = 'sweep-5'`;
      expected.set("sweep-5", laterAt);
      yield* sql`
        UPDATE projection_threads SET settled_override = 'active', settled_at = NULL
        WHERE thread_id = 'sweep-6'
      `;
      expected.set("sweep-6", null);

      const eventsBefore = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      yield* runMigrations({ toMigrationInclusive: 49 });
      const threadsBefore = yield* sql<{ readonly thread_id: string }>`
        SELECT * FROM projection_threads ORDER BY thread_id
      `;
      assert.deepStrictEqual(
        yield* sql`SELECT settled_at FROM projection_threads WHERE thread_id = 'sweep-1'`,
        [{ settled_at: "2026-09-04T13:33:02.500Z" }],
      );

      yield* runMigrations();
      const threadsAfter = yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`;
      assert.deepStrictEqual(
        threadsAfter,
        threadsBefore.map((thread) => ({
          ...thread,
          settled_at: expected.get(thread.thread_id),
        })),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        eventsBefore,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      yield* migrateClientSettlements;
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`,
        threadsAfter,
      );
    }),
  );
});

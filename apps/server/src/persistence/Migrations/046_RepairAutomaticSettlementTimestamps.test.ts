import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const MODEL_SELECTION = '{"instanceId":"codex","model":"gpt-5.6-sol"}';

layer("046_RepairAutomaticSettlementTimestamps", (it) => {
  it.effect("repairs automatic stamps and leaves manual settlement alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          latest_turn_id,
          created_at,
          updated_at,
          latest_user_message_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES
          (
            'thread-auto', 'project-1', 'Automatic', ${MODEL_SELECTION}, 'turn-auto',
            '2026-05-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
            'settled', '2026-09-01T00:00:00.000Z', NULL
          ),
          (
            'thread-auto-no-activity', 'project-1', 'Automatic without activity', ${MODEL_SELECTION}, NULL,
            '2026-05-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL,
            'settled', '2026-09-01T00:00:00.000Z', NULL
          ),
          (
            'thread-auto-later-activity', 'project-1', 'Automatic then active', ${MODEL_SELECTION}, NULL,
            '2026-05-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z',
            'settled', '2026-09-01T00:00:00.000Z', NULL
          ),
          (
            'thread-manual', 'project-1', 'Manual', ${MODEL_SELECTION}, NULL,
            '2026-05-01T00:00:00.000Z', '2026-08-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z',
            'settled', '2026-08-10T00:00:00.000Z', NULL
          ),
          (
            'thread-resettled', 'project-1', 'Manually re-settled', ${MODEL_SELECTION}, NULL,
            '2026-05-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-06-05T00:00:00.000Z',
            'settled', '2026-09-02T00:00:00.000Z', NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES
          ('message-auto', 'thread-auto', 'turn-auto', 'user', 'Prompt', 0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
          ('message-later-old', 'thread-auto-later-activity', NULL, 'user', 'Prompt', 0, '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z'),
          ('message-later-new', 'thread-auto-later-activity', NULL, 'user', 'Prompt', 0, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z'),
          ('message-manual', 'thread-manual', NULL, 'user', 'Prompt', 0, '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z'),
          ('message-resettled', 'thread-resettled', NULL, 'user', 'Prompt', 0, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z')
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json
        )
        VALUES (
          'thread-auto', 'turn-auto', 'completed',
          '2026-06-02T00:00:00.000Z', '2026-06-02T00:01:00.000Z', '2026-06-03T00:00:00.000Z', '[]'
        )
      `;

      const settledEvent = (
        eventId: string,
        threadId: string,
        version: number,
        occurredAt: string,
        commandId: string,
        settledAt: string,
      ) =>
        sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          )
          VALUES (
            ${eventId}, 'thread', ${threadId}, ${version}, 'thread.settled', ${occurredAt},
            ${commandId}, NULL, ${commandId},
            ${commandId.startsWith("server:") ? "server" : "client"},
            ${JSON.stringify({ threadId, settledAt, updatedAt: occurredAt })}, '{}'
          )
        `;
      const automatic = (threadId: string) => `server:auto-settle:${threadId}:uuid`;
      const sweptAt = "2026-09-01T00:00:00.000Z";

      yield* settledEvent(
        "event-auto",
        "thread-auto",
        0,
        sweptAt,
        automatic("thread-auto"),
        sweptAt,
      );
      // A later manual settle re-emits the bad stamp; only the projection matters.
      yield* settledEvent(
        "event-auto-repeat",
        "thread-auto",
        1,
        "2026-09-01T00:00:05.000Z",
        "command-repeat",
        sweptAt,
      );
      yield* settledEvent(
        "event-auto-no-activity",
        "thread-auto-no-activity",
        0,
        sweptAt,
        automatic("thread-auto-no-activity"),
        sweptAt,
      );
      yield* settledEvent(
        "event-auto-later-activity",
        "thread-auto-later-activity",
        0,
        sweptAt,
        automatic("thread-auto-later-activity"),
        sweptAt,
      );
      yield* settledEvent(
        "event-manual",
        "thread-manual",
        0,
        "2026-08-10T00:00:00.000Z",
        "command-manual",
        "2026-08-10T00:00:00.000Z",
      );
      yield* settledEvent(
        "event-resettled-auto",
        "thread-resettled",
        0,
        sweptAt,
        automatic("thread-resettled"),
        sweptAt,
      );
      yield* settledEvent(
        "event-resettled-manual",
        "thread-resettled",
        1,
        "2026-09-02T00:00:00.000Z",
        "command-resettled-manual",
        "2026-09-02T00:00:00.000Z",
      );

      const eventsBefore =
        yield* sql`SELECT payload_json FROM orchestration_events ORDER BY event_id`;

      yield* runMigrations({ toMigrationInclusive: 46 });

      const threads = yield* sql<{
        readonly threadId: string;
        readonly settledAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          thread_id AS "threadId",
          settled_at AS "settledAt",
          updated_at AS "updatedAt"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(threads, [
        // Latest activity at or before the sweep: the turn completion.
        {
          threadId: "thread-auto",
          settledAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        // Activity after the sweep is ignored; the older message wins.
        {
          threadId: "thread-auto-later-activity",
          settledAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
        },
        // No messages or turns: fall back to creation, matching the reactor.
        {
          threadId: "thread-auto-no-activity",
          settledAt: "2026-05-02T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          threadId: "thread-manual",
          settledAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        },
        // Manually re-settled after the sweep keeps the manual stamp.
        {
          threadId: "thread-resettled",
          settledAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ]);

      const eventsAfter =
        yield* sql`SELECT payload_json FROM orchestration_events ORDER BY event_id`;
      assert.deepStrictEqual(eventsAfter, eventsBefore);
    }),
  );
});

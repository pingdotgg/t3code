import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("backfills the V2 event driver from payload before the legacy provider column", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 38 });

    yield* sql`
      INSERT INTO orchestration_v2_events (
        event_id,
        thread_id,
        provider,
        event_type,
        occurred_at,
        payload_json
      ) VALUES
        (
          'event:explicit-driver',
          'thread:explicit-driver',
          'codex-work',
          'thread.created',
          '2026-07-29T00:00:00.000Z',
          '{"driver":"codex","providerInstanceId":"codex-work"}'
        ),
        (
          'event:legacy-provider',
          'thread:legacy-provider',
          'claude-agent',
          'thread.created',
          '2026-07-29T00:00:00.000Z',
          '{}'
        )
    `;

    yield* runMigrations({ toMigrationInclusive: 39 });

    const events = yield* sql<{
      readonly event_id: string;
      readonly driver: string;
      readonly provider_instance_id: string;
    }>`
      SELECT event_id, driver, provider_instance_id
      FROM orchestration_v2_events
      ORDER BY event_id
    `;
    assert.deepStrictEqual(events, [
      {
        event_id: "event:explicit-driver",
        driver: "codex",
        provider_instance_id: "codex-work",
      },
      {
        event_id: "event:legacy-provider",
        driver: "claude-agent",
        provider_instance_id: "claude-agent",
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

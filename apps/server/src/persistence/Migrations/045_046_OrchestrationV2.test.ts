import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_046_OrchestrationV2", (it) => {
  it.effect("keeps released and private migration ids contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 53 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("installs the orchestration v2 and subagent schemas", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id IN (43, 44, 45, 46)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 43,
          name: "ProjectionThreadsUnsettledAt",
        },
        {
          migration_id: 44,
          name: "ClearAutomaticProjectModelDefaults",
        },
        {
          migration_id: 45,
          name: "OrchestrationV2",
        },
        {
          migration_id: 46,
          name: "OrchestrationV2Subagents",
        },
      ]);

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_events)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;

      assert.ok(eventColumns.some((column) => column.name === "event_id"));
      assert.ok(subagentColumns.some((column) => column.name === "child_thread_id"));
    }),
  );

  it.effect("backfills provider-session thread bindings in migration 048", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_sessions (
          provider_session_id,
          thread_id,
          provider,
          driver,
          provider_instance_id,
          status,
          model,
          updated_at,
          payload_json
        ) VALUES (
          'provider-session:shared',
          'thread:existing',
          'codex',
          'codex',
          'codex',
          'ready',
          'gpt-5.4',
          '2026-01-01T00:00:00.000Z',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const bindings = yield* sql<{
        readonly provider_session_id: string;
        readonly thread_id: string;
      }>`
        SELECT provider_session_id, thread_id
        FROM orchestration_v2_projection_provider_session_bindings
      `;
      assert.deepStrictEqual(bindings, [
        {
          provider_session_id: "provider-session:shared",
          thread_id: "thread:existing",
        },
      ]);
    }),
  );

  it.effect("preserves turn items with colliding ordinals in migration 047", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id,
          thread_id,
          ordinal,
          provider,
          status,
          requested_at,
          payload_json
        ) VALUES (
          'run:one',
          'thread:one',
          1,
          'codex',
          'completed',
          '2026-01-01T00:00:00.000Z',
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id,
          thread_id,
          run_id,
          ordinal,
          type,
          status,
          updated_at,
          payload_json
        ) VALUES
          ('turn-item:b', 'thread:one', 'run:one', 7, 'assistant_message', 'completed', '2026-01-01T00:00:00.000Z', '{}'),
          ('turn-item:a', 'thread:one', 'run:one', 7, 'assistant_message', 'completed', '2026-01-01T00:00:00.000Z', '{}'),
          ('turn-item:c', 'thread:one', 'run:one', 9, 'assistant_message', 'completed', '2026-01-01T00:00:00.000Z', '{}'),
          ('turn-item:d', 'thread:two', NULL, 42, 'assistant_message', 'completed', '2026-01-01T00:00:00.000Z', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const positions = yield* sql<{
        readonly thread_id: string;
        readonly turn_item_id: string;
        readonly ordinal: number;
      }>`
        SELECT thread_id, turn_item_id, ordinal
        FROM orchestration_v2_turn_item_positions
        ORDER BY thread_id, ordinal
      `;
      assert.deepStrictEqual(positions, [
        { thread_id: "thread:one", turn_item_id: "turn-item:a", ordinal: 1_000_001 },
        { thread_id: "thread:one", turn_item_id: "turn-item:b", ordinal: 1_000_002 },
        { thread_id: "thread:one", turn_item_id: "turn-item:c", ordinal: 1_000_003 },
        { thread_id: "thread:two", turn_item_id: "turn-item:d", ordinal: 1 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});

it.effect("upgrades a database already at released main migration 043", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* runMigrations({ toMigrationInclusive: 43 });
    const snoozeColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_threads)
    `;
    assert.ok(snoozeColumns.some((column) => column.name === "snoozed_until"));
    assert.ok(snoozeColumns.some((column) => column.name === "snoozed_at"));

    yield* runMigrations({ toMigrationInclusive: 53 });

    const migrations = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`
      SELECT migration_id, name
      FROM effect_sql_migrations
      WHERE migration_id BETWEEN 39 AND 53
      ORDER BY migration_id
    `;
    assert.deepStrictEqual(
      migrations.map(({ migration_id, name }) => [migration_id, name]),
      [
        [39, "ProjectionProjectsDefaultThreadEnvMode"],
        [40, "ProjectionProjectFaviconPath"],
        [41, "AuthSessionClientConnection"],
        [42, "ProjectionThreadLinkedPullRequest"],
        [43, "ProjectionThreadsUnsettledAt"],
        [44, "ClearAutomaticProjectModelDefaults"],
        [45, "OrchestrationV2"],
        [46, "OrchestrationV2Subagents"],
        [47, "OrchestrationV2Foundation"],
        [48, "OrchestrationV2ProviderSessionBindings"],
        [49, "OrchestrationV2ThreadLaunchWorkflows"],
        [50, "ApplicationEventSource"],
        [51, "OrchestrationV2EffectCancellation"],
        [52, "ScheduledTasks"],
        [53, "LegacyV1ImportState"],
      ],
    );

    const v2Tables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
    `;
    assert.strictEqual(v2Tables.length, 1);

    const legacyImportTables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'orchestration_v2_legacy_imports'
    `;
    assert.strictEqual(legacyImportTables.length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionProjectsAutoPull from "./083_ProjectionProjectsAutoPull.ts";
import ProjectionThreadMessageSequence from "./083_ProjectionThreadMessageSequence.ts";
import repair from "./084_RepairDivergentProjectAndMessageSchema.ts";

for (const [name, migration] of [
  ["ProjectionProjectsAutoPull", ProjectionProjectsAutoPull],
  ["ProjectionThreadMessageSequence", ProjectionThreadMessageSequence],
] as const) {
  it.effect(`repairs the historical ${name} ledger without rewriting it`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project', 'Project', '/project', '[]', '2026-09-05', '2026-09-05')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('message', 'thread', 'user', 'hello', 0, '2026-09-05', '2026-09-05')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          1, 'event', 'thread', 'thread', 1, 'thread.message-sent', '2026-09-05',
          'user', '{"messageId":"message"}', '{}'
        )
      `;
      yield* migration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (83, ${name})`;
      if (name === "ProjectionProjectsAutoPull") {
        yield* sql`UPDATE projection_projects SET auto_pull = 1`;
      } else {
        yield* sql`UPDATE projection_thread_messages SET sequence = 99`;
      }

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [
          84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104,
          105, 106, 107, 108, 109, 110, 111, 112, 113,
        ],
      );
      yield* repair;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 83`,
        [{ name }],
      );
      assert.deepStrictEqual(yield* sql`SELECT auto_pull FROM projection_projects`, [
        { auto_pull: name === "ProjectionProjectsAutoPull" ? 1 : 0 },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT sequence FROM projection_thread_messages`, [
        { sequence: name === "ProjectionProjectsAutoPull" ? 1 : 99 },
      ]);
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_messages)
      `;
      assert.isTrue(
        indexes.some(({ name }) => name === "idx_projection_thread_messages_thread_sequence"),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect("installs both schemas on a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const projects = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
    const messages = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_thread_messages)
    `;
    assert.isTrue(projects.some(({ name }) => name === "auto_pull"));
    assert.isTrue(messages.some(({ name }) => name === "sequence"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

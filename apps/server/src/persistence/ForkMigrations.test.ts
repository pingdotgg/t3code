import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import SubagentModelSelection from "./ForkMigrations/001_SubagentModelSelection.ts";
import ThreadViewed from "./ForkMigrations/002_ThreadViewed.ts";
import AgentMailbox from "./ForkMigrations/003_AgentMailbox.ts";
import MailboxWake from "./ForkMigrations/004_MailboxWake.ts";
import { runForkMigrations } from "./ForkMigrations.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

const earlyForkEntries = migrationEntries.map(([id, name, migration]) =>
  id === 44
    ? ([id, "ProjectionThreadSubagentModelSelection", SubagentModelSelection] as const)
    : ([id, name, migration] as const),
);

const legacyForkEntries = [
  ...earlyForkEntries.filter(([id]) => id <= 47),
  [48, "ProjectionThreadSubagentModelSelection", SubagentModelSelection],
  [49, "ProjectionThreadsLastViewedAt", ThreadViewed],
  [50, "AgentMailbox", AgentMailbox],
  [51, "MailboxWake", MailboxWake],
  ...migrationEntries
    .filter(([id]) => id >= 48 && id <= 54)
    .map(([id, name, migration]) => [id + 4, name, migration] as const),
] as const;

const prepareLegacyFork = (through: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        legacyForkEntries
          .filter(([id]) => id <= through)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });

it.effect.each([44, 47, 48, 49, 50, 51, 53, 56, 58])(
  "upgrades fork schema %s to V2 without losing credentials or mailbox messages",
  (startingMigration) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* prepareLegacyFork(startingMigration);
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('phone', 'owner', '["admin"]', 'pairing', '2026-09-01', '2027-09-01')`;
      if (startingMigration >= 50) {
        yield* sql`INSERT INTO projection_mailbox_messages
          (id, from_thread_id, to_thread_id, execution_id, body, state, created_at, updated_at, queued_sequence)
          VALUES ('pending', 'sender', 'receiver', 'execution', 'Keep this message', 'queued', '2026-09-01', '2026-09-01', 1)`;
      }
      const credentials = yield* sql`SELECT * FROM auth_sessions`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM auth_sessions`,
        credentials.map((credential) => ({ ...credential, proof_key_thumbprint: null })),
      );
      const messages = yield* sql`SELECT id, body, state FROM projection_mailbox_messages`;
      assert.deepStrictEqual(
        messages,
        startingMigration >= 50
          ? [{ id: "pending", body: "Keep this message", state: "queued" }]
          : [],
      );
      const history = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
      assert.includeMembers(
        tables.map((row) => row.name),
        ["orchestration_v2_events", "orchestration_v2_projection_threads", "pseudocode_migrations"],
      );
      const forkHistory = yield* sql`SELECT * FROM pseudocode_migrations ORDER BY migration_id`;
      assert.lengthOf(forkHistory, 4);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM pseudocode_migrations ORDER BY migration_id`,
        forkHistory,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["early", "legacy", "separate"] as const)(
  "repairs the migration 44 collision with a %s fork ledger without clearing explicit defaults",
  (ledger) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (ledger === "separate") {
        yield* Migrator.make({})({
          loader: Migrator.fromRecord(
            Object.fromEntries(
              earlyForkEntries
                .filter(([id]) => id <= 54)
                .map(([id, name, migration]) => [`${id}_${name}`, migration]),
            ),
          ),
        });
        yield* runForkMigrations();
      } else {
        yield* prepareLegacyFork(ledger === "early" ? 44 : 58);
      }
      const selection = '{"instanceId":"codex","model":"gpt-6-sol"}';
      for (const project of ["auto", "explicit"]) {
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
          VALUES (${project}, ${project}, ${`/tmp/${project}`}, ${selection}, '[]', '2026-09-01', '2026-09-01')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`${project}-created`}, 'project', ${project}, 0, 'project.created', '2026-09-01', 'client',
            ${`{"defaultModelSelection":${selection}}`}, '{}')`;
      }
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES ('explicit-updated', 'project', 'explicit', 1, 'project.meta-updated', '2026-09-01', 'client',
          ${`{"defaultModelSelection":${selection}}`}, '{}')`;
      if (ledger === "separate") {
        // Simulate a V2 database imported before the missing repair was discovered.
        yield* Migrator.make({})({
          loader: Migrator.fromRecord(
            Object.fromEntries(
              earlyForkEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
            ),
          ),
        });
      }
      const createdAt = yield* sql`
        SELECT created_at FROM effect_sql_migrations WHERE migration_id = 44
      `;

      yield* runMigrations();

      assert.deepStrictEqual(
        yield* sql`SELECT project_id, default_model_selection_json FROM projection_projects ORDER BY project_id`,
        [
          { project_id: "auto", default_model_selection_json: null },
          { project_id: "explicit", default_model_selection_json: selection },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT stream_id, application_event_version AS version,
          json_extract(payload_json, '$.defaultModelSelection.model') AS model
          FROM orchestration_events WHERE event_type = 'project.created' ORDER BY stream_id, version`,
        [
          { stream_id: "auto", version: 1, model: null },
          { stream_id: "auto", version: 2, model: null },
          { stream_id: "explicit", version: 1, model: "gpt-6-sol" },
          { stream_id: "explicit", version: 2, model: "gpt-6-sol" },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 44`,
        [{ name: "ClearAutomaticProjectModelDefaults" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 44`,
        createdAt,
      );
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const events = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        events,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adds fork schema to an upstream database without changing its migration history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
        ),
      ),
    });
    const upstreamHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      upstreamHistory,
    );
    assert.lengthOf(yield* sql`SELECT * FROM pseudocode_migrations`, 4);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects an unknown fork ledger without partially rewriting history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* prepareLegacyFork(58);
    yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownLocalMigration' WHERE migration_id = 57`;
    const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const result = yield* runMigrations().pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      history,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_events'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

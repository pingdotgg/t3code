import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import BotProfiles from "./Migrations/108_BotProfiles.ts";

it.effect("upgrades a database that started the old bot migrations without losing profiles", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 105 });
    yield* Migrator.make({})({ loader: Migrator.fromRecord({ "106_BotProfiles": BotProfiles }) });
    yield* sql`INSERT INTO bot_profiles (thread_id, project_id, state, revision) VALUES ('bot:test', 'project', 'active', 1)`;

    yield* runMigrations();
    const history = yield* sql<{
      name: string;
    }>`SELECT name FROM effect_sql_migrations WHERE migration_id >= 106 ORDER BY migration_id`;
    assert.deepEqual(
      history.map(({ name }) => name),
      [
        "WorktreePathKeyIndex",
        "DeferredSlashCommandIndex",
        "BotProfiles",
        "BotActivationGrants",
        "BotWork",
        "BotWorkflowTriggers",
        "BotAccess",
      ],
    );
    assert.deepEqual(yield* sql`SELECT thread_id, access_json FROM bot_profiles`, [
      { thread_id: "bot:test", access_json: null },
    ]);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";
import { ProjectionThreadGoalRepositoryLive } from "../Services/ProjectionThreadGoals.ts";
import { makeRuntimeSqliteLayer } from "../RuntimeSqliteLayer.ts";

const repairMainMigrationLedger = Effect.fn("repairMainMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const migrationLedgerColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(effect_sql_migrations)
  `;
  if (migrationLedgerColumns.length === 0) {
    return;
  }

  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id = 31
      AND name = 'ProjectionThreadGoals'
  `;
});

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* repairMainMigrationLedger();
    yield* runMigrations();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    ProjectionThreadGoalRepositoryLive,
    Layer.provideMerge(
      setup,
      makeRuntimeSqliteLayer({
        filename: dbPath,
        spanAttributes: {
          "db.name": path.basename(dbPath),
          "service.name": "t3-server",
        },
      }),
    ),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  ProjectionThreadGoalRepositoryLive,
  Layer.provideMerge(setup, makeRuntimeSqliteLayer({ filename: ":memory:" })),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);

import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = defaultSqliteClientLoaders[runtime];
    const clientModule = yield* Effect.promise<Loader>(loader);
    return clientModule.layer(config);
  }).pipe(Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations;
  }),
);

export const makeSqlitePersistenceLive = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    return Layer.provideMerge(setup, makeRuntimeSqliteLayer({ filename: dbPath }));
  }).pipe(Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const { join } = yield* Path.Path;
  const dbPath = join(stateDir, "orchestration.sqlite");
  return makeSqlitePersistenceLive(dbPath);
}).pipe(Layer.unwrap);

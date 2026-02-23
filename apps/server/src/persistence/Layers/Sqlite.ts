import { Effect, Layer, FileSystem, Path } from "effect";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../SqliteClient.ts";

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
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

    return Layer.provideMerge(setup, SqliteClient.layer({ filename: dbPath }));
  }).pipe(Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(setup, SqliteClient.layerMemory());

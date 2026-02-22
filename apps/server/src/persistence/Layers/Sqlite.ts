import fs from "node:fs";
import path from "node:path";

import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer, ServiceMap } from "effect";



import { runMigrations } from "../Migrations.ts";

export interface PersistenceConfigShape {
  readonly dbPath: string;
}

export class PersistenceConfig extends ServiceMap.Service<
  PersistenceConfig,
  PersistenceConfigShape
>()("persistence/Config") {}

export function makeSqlitePersistenceLive(dbPath: string) {
  const SqliteClientLive = Layer.unwrap(
    Effect.sync(() => {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      return SqliteClient.layer({ filename: dbPath });
    }),
  );

  return Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* runMigrations;
      return sql;
    }),
  ).pipe(Layer.provide(SqliteClientLive));
}


export const SqlitePersistenceLive = Layer.unwrap(
  Effect.map(Effect.service(PersistenceConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);

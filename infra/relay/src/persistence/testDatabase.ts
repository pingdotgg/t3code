import { PgClient } from "@effect/sql-pg/PgClient";
import { PGlite } from "@electric-sql/pglite";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as RelayDb from "../db.ts";

class TestQueryError extends Schema.TaggedError<TestQueryError>()("TestQueryError", {
  sql: Schema.String,
  cause: Schema.Defect(),
}) {}

// Runs the production drizzle queries against an in-memory Postgres with every relay migration applied.
export const makeTestRelayDb = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pg = yield* Effect.acquireRelease(
    Effect.promise(() => PGlite.create()),
    (client) => Effect.promise(() => client.close()),
  );
  const migrationsDir = yield* path.fromFileUrl(
    new URL("../../migrations/postgres/", import.meta.url),
  );
  for (const name of (yield* fs.readDirectory(migrationsDir)).toSorted()) {
    const migration = yield* fs.readFileString(path.join(migrationsDir, name, "migration.sql"));
    yield* Effect.promise(() => pg.exec(migration));
  }
  const query = (sql: string, params: ReadonlyArray<unknown>, rowMode?: "array") =>
    Effect.tryPromise({
      try: () => pg.query(sql, [...params], rowMode ? { rowMode } : undefined),
      catch: (cause) => new TestQueryError({ sql, cause }),
    });
  // The subset of @effect/sql-pg's PgClient that drizzle's effect-postgres session calls.
  const client = {
    unsafe: (sql: string, params: ReadonlyArray<unknown> = []) => ({
      raw: query(sql, params),
      values: query(sql, params, "array").pipe(Effect.map((result) => result.rows)),
      withoutTransform: query(sql, params).pipe(Effect.map((result) => result.rows)),
    }),
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  };
  const db = yield* PgDrizzle.makeWithDefaults().pipe(
    Effect.provideService(PgClient, client as unknown as PgClient),
  );
  return db as unknown as RelayDb.RelayDb["Service"];
});

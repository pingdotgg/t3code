import * as NodeServices from "@effect/platform-node/NodeServices";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as RelayDb from "../db.ts";

// Production builders are Effects; PGlite's are promises, so each one becomes an Effect when yielded.
const asEffects = (value: object): unknown =>
  new Proxy(value, {
    get(target, key) {
      if (key === Symbol.iterator) {
        return () => Effect.promise(() => target as PromiseLike<unknown>)[Symbol.iterator]();
      }
      const member: unknown = Reflect.get(target, key);
      if (typeof member !== "function") return member;
      return (...args: Array<unknown>) => {
        const result: unknown = member.apply(target, args);
        return typeof result === "object" && result !== null ? asEffects(result) : result;
      };
    },
  });

/** A migrated in-memory Postgres; `db` seeds and reads rows, `layer` provides it as RelayDb. */
export const makePgliteRelayDb = Effect.gen(function* () {
  const pg = yield* Effect.acquireRelease(
    Effect.promise(() => PGlite.create()),
    (client) => Effect.promise(() => client.close()),
  );
  yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* path.fromFileUrl(
      new URL("../../migrations/postgres/", import.meta.url),
    );
    for (const name of (yield* fs.readDirectory(migrationsDir)).toSorted()) {
      const migration = yield* fs.readFileString(`${migrationsDir}${name}/migration.sql`);
      yield* Effect.promise(() => pg.exec(migration));
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
  const db = drizzle({ client: pg });
  return {
    db,
    layer: Layer.succeed(RelayDb.RelayDb, asEffects(db) as RelayDb.RelayDb["Service"]),
  };
});

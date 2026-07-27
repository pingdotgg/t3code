import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

interface User {
  id: string;
  name: string;
}

// Binding a D1 database inside an Action via `QueryDatabaseLocal` — the local
// (current-credentials) implementation of the `QueryDatabase` binding. Exercises
// both the binding client (exec/prepare/run/all) and the accessor mechanism
// (`yield* database.databaseId` resolved at apply time).
test.provider(
  "QueryDatabaseLocal: seed and query a database from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* Cloudflare.D1.Database("SeedDatabase");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const db = yield* Cloudflare.D1.QueryDatabase(database);
              // Accessor — resolved at apply time against the tracker.
              const databaseId = yield* database.databaseId;

              return Effect.fn(function* () {
                yield* db.exec(
                  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT)",
                );
                yield* db.prepare("DELETE FROM users").run();
                yield* db
                  .prepare("INSERT INTO users (id, name) VALUES (?, ?)")
                  .bind("1", "Ada")
                  .run();
                yield* db
                  .prepare("INSERT INTO users (id, name) VALUES (?, ?)")
                  .bind("2", "Grace")
                  .run();

                const rows = yield* db
                  .prepare("SELECT id, name FROM users ORDER BY id")
                  .all<User>();

                const first = yield* db
                  .prepare("SELECT name FROM users WHERE id = ?")
                  .bind("1")
                  .first<string>("name");

                return {
                  databaseId: yield* databaseId,
                  users: rows.results,
                  first,
                };
              });
            }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
          );

          return yield* Seed({});
        }),
      );

      expect(out.databaseId).toBeTruthy();
      expect(out.users).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ]);
      expect(out.first).toBe("Ada");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Native D1 bind values (number/null/boolean/binary) must round-trip, not just
// strings: the HTTP API binds verbatim, so the Local shim mirrors native D1
// (booleans -> 1/0, binary -> BLOB) and Distilled models params as unknown[].
test.provider(
  "QueryDatabaseLocal: binds non-string parameters (single + batch)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* Cloudflare.D1.Database("TypedBindDatabase");

          const Query = Action(
            "QueryTypedBind",
            Effect.gen(function* () {
              const db = yield* Cloudflare.D1.QueryDatabase(database);
              return Effect.fn(function* () {
                // Single statement: number, null, boolean (-> 1/0) via SELECT ?.
                const num = yield* db
                  .prepare("SELECT ? AS value")
                  .bind(42)
                  .first<number>("value");
                const nul = yield* db
                  .prepare("SELECT ? AS value")
                  .bind(null)
                  .first<null>("value");
                const boolTrue = yield* db
                  .prepare("SELECT ? AS value")
                  .bind(true)
                  .first<number>("value");
                const boolFalse = yield* db
                  .prepare("SELECT ? AS value")
                  .bind(false)
                  .first<number>("value");

                // Batch: mixed-type params across statements round-trip too.
                yield* db.exec(
                  "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, qty INTEGER, note TEXT)",
                );
                yield* db.prepare("DELETE FROM items").run();
                yield* db.batch([
                  db
                    .prepare(
                      "INSERT INTO items (id, qty, note) VALUES (?, ?, ?)",
                    )
                    .bind(1, 10, null),
                  db
                    .prepare(
                      "INSERT INTO items (id, qty, note) VALUES (?, ?, ?)",
                    )
                    .bind(2, 20, "second"),
                ]);
                const rows = yield* db
                  .prepare("SELECT id, qty, note FROM items ORDER BY id")
                  .all<{ id: number; qty: number; note: string | null }>();

                // Binary (BLOB): bind a Uint8Array, read the byte length back.
                const blobLen = yield* db
                  .prepare("SELECT length(?) AS len")
                  .bind(new Uint8Array([1, 2, 3, 4]))
                  .first<number>("len");

                return {
                  num,
                  nul,
                  boolTrue,
                  boolFalse,
                  rows: rows.results,
                  blobLen,
                };
              });
            }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
          );

          return yield* Query({});
        }),
      );

      expect(out.num).toBe(42);
      expect(out.nul).toBeNull();
      expect(out.boolTrue).toBe(1);
      expect(out.boolFalse).toBe(0);
      expect(out.rows).toEqual([
        { id: 1, qty: 10, note: null },
        { id: 2, qty: 20, note: "second" },
      ]);
      expect(out.blobLen).toBe(4);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

import { applyMigrations } from "@/SQL/Migrations/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Database } from "bun:sqlite";
import { expect, layer } from "alchemy-test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import * as Effect from "effect/Effect";
import { makeSqliteExecutor, tableNames } from "./sqlite-executor.ts";

/**
 * Adopting a drizzle-kit-migrated database (the Seth case): the user ran
 * `drizzle-kit generate` + `drizzle-kit migrate` before Alchemy ever saw
 * the database. Migrating to Alchemy is a ONE-WAY conversion — drizzle's
 * REAL migrator (bun-sqlite driver) produces the starting state, our flow
 * copies its history into `__alchemy_migrations` and owns bookkeeping from
 * then on; `__drizzle_migrations` is frozen, never written or dropped.
 */

const fixturesDir = new URL("./fixtures/drizzle-v1", import.meta.url).pathname;

const describe = layer(NodeServices.layer);

const rowsOf = (db: Database, table: string) =>
  db.query(`SELECT hash, name FROM ${table} ORDER BY id;`).all() as Array<{
    hash: string;
    name: string;
  }>;

describe("drizzle adoption (one-way conversion)", (it) => {
  it.effect(
    "converts drizzle-kit history into __alchemy_migrations without replaying",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        // The user's pre-Alchemy state, produced by drizzle's own migrator.
        yield* Effect.sync(() =>
          drizzleMigrate(drizzle({ client: db }), {
            migrationsFolder: fixturesDir,
          }),
        );
        const drizzleRows = rowsOf(db, "__drizzle_migrations");
        expect(drizzleRows.length).toBe(2);

        // First Alchemy deploy: adopt. A replay would throw on the bare
        // CREATE TABLEs, so passing proves conversion-not-reapplication.
        const executor = makeSqliteExecutor(db);
        yield* applyMigrations({
          resolved: { dir: fixturesDir, table: "__alchemy_migrations" },
          executor,
        });

        const ours = rowsOf(db, "__alchemy_migrations");
        expect(ours.map((r) => r.name)).toEqual([
          "20240101000000_init",
          "20240102000000_add_posts",
        ]);
        // drizzle's hashes are sha256 of migration.sql — carried verbatim.
        expect(ours.map((r) => r.hash)).toEqual(drizzleRows.map((r) => r.hash));
        // The drizzle table is frozen, not dropped.
        expect(rowsOf(db, "__drizzle_migrations")).toEqual(drizzleRows);
        expect(tableNames(db)).toEqual(
          expect.arrayContaining(["users", "posts", "__drizzle_migrations"]),
        );
      }),
  );

  it.effect("after conversion, drizzle's table is never written again", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      yield* Effect.sync(() =>
        drizzleMigrate(drizzle({ client: db }), {
          migrationsFolder: fixturesDir,
        }),
      );
      const frozen = rowsOf(db, "__drizzle_migrations");

      const executor = makeSqliteExecutor(db);
      yield* applyMigrations({
        resolved: { dir: fixturesDir, table: "__alchemy_migrations" },
        executor,
      });
      yield* applyMigrations({
        resolved: { dir: fixturesDir, table: "__alchemy_migrations" },
        executor,
      });

      // One-way: drizzle's table never moves again.
      expect(rowsOf(db, "__drizzle_migrations")).toEqual(frozen);
      expect(rowsOf(db, "__alchemy_migrations").length).toBe(2);
    }),
  );

  it.effect("our flow is idempotent across repeated deploys", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      yield* applyMigrations({
        resolved: { dir: fixturesDir, table: "__alchemy_migrations" },
        executor,
      });
      const first = rowsOf(db, "__alchemy_migrations");
      yield* applyMigrations({
        resolved: { dir: fixturesDir, table: "__alchemy_migrations" },
        executor,
      });
      expect(rowsOf(db, "__alchemy_migrations")).toEqual(first);
      // No drizzle table was ever created on a greenfield database.
      expect(tableNames(db)).not.toContain("__drizzle_migrations");
    }),
  );
});

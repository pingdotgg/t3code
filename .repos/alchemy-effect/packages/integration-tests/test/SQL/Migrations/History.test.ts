import { classifyMigrationHistory, rewrittenMigrationHistory } from "@alchemy.run/sql/Migrations";
import { hashMigrations } from "@alchemy.run/sql/SqlFile";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const describe = layer(NodeServices.layer);

describe("rewrittenMigrationHistory", (it) => {
  it.effect(
    "treats missing prior hashes as not rewritten",
    () =>
      Effect.sync(() => {
        expect(rewrittenMigrationHistory(undefined, { "0001.sql": "aaa" })).toBeUndefined();
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "treats additive files as not rewritten",
    () =>
      Effect.sync(() => {
        expect(
          rewrittenMigrationHistory(
            { "0001.sql": "aaa" },
            { "0001.sql": "aaa", "0002.sql": "bbb" },
          ),
        ).toBeUndefined();
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "detects a changed hash on an already-applied file",
    () =>
      Effect.sync(() => {
        expect(
          rewrittenMigrationHistory(
            { "0001.sql": "aaa", "0002.sql": "bbb" },
            { "0001.sql": "ccc", "0002.sql": "bbb" },
          ),
        ).toEqual({ changed: ["0001.sql"], removed: [] });
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "detects a removed already-applied file",
    () =>
      Effect.sync(() => {
        expect(
          rewrittenMigrationHistory(
            { "0001.sql": "aaa", "0002.sql": "bbb" },
            { "0002.sql": "bbb" },
          ),
        ).toEqual({ changed: [], removed: ["0001.sql"] });
      }),
    { tags: ["unit", "local"] },
  );
});

const writeDir = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-mig-hist-",
    });
    for (const [name, sql] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(dir, name), sql);
    }
    return dir;
  });

describe("classifyMigrationHistory", (it) => {
  it.effect(
    "classifies a new file as pending",
    () =>
      Effect.gen(function* () {
        const dir = yield* writeDir({
          "0001_init.sql": "CREATE TABLE users (id int);",
          "0002_posts.sql": "CREATE TABLE posts (id int);",
        });
        const hashes = yield* hashMigrations(dir);
        const previous = { ...hashes };
        delete previous["0002_posts.sql"];
        const change = yield* classifyMigrationHistory({
          news: { migrations: dir },
          output: {
            migrationsTable: "__alchemy_migrations",
            migrationsHashes: previous,
          },
        });
        expect(change).toEqual({ kind: "pending" });
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "classifies an edited prior file as rewritten",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* writeDir({
          "0001_init.sql": "CREATE TABLE users (id int);",
        });
        const previous = yield* hashMigrations(dir);
        yield* fs.writeFileString(
          path.join(dir, "0001_init.sql"),
          "CREATE TABLE users (id int, name text);",
        );
        const change = yield* classifyMigrationHistory({
          news: { migrations: dir },
          output: {
            migrationsTable: "__alchemy_migrations",
            migrationsHashes: previous,
          },
        });
        expect(change.kind).toBe("rewritten");
        if (change.kind === "rewritten") {
          expect(change.changed).toEqual(["0001_init.sql"]);
          expect(change.removed).toEqual([]);
        }
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "classifies a deleted prior file as rewritten",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* writeDir({
          "0001_init.sql": "CREATE TABLE users (id int);",
          "0002_posts.sql": "CREATE TABLE posts (id int);",
        });
        const previous = yield* hashMigrations(dir);
        yield* fs.remove(path.join(dir, "0001_init.sql"));
        const change = yield* classifyMigrationHistory({
          news: { migrations: dir },
          output: {
            migrationsTable: "__alchemy_migrations",
            migrationsHashes: previous,
          },
        });
        expect(change.kind).toBe("rewritten");
        if (change.kind === "rewritten") {
          expect(change.changed).toEqual([]);
          expect(change.removed).toEqual(["0001_init.sql"]);
        }
      }),
    { tags: ["unit", "local"] },
  );
});

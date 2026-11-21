// @effect-diagnostics-next-line nodeBuiltinImport:off - models btrfs flags by inode for the plain-Node helpers.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  needsNoCopyOnWriteRewrite,
  type NoCopyOnWriteAttributes,
  rewriteNoCopyOnWrite,
} from "./noCopyOnWrite.ts";

// Like btrfs: the flag belongs to the inode, and a file takes it only while empty.
const fakeBtrfs = (): NoCopyOnWriteAttributes => {
  const marked = new Set<number>();
  return {
    supported: async () => true,
    mark: async (path) => {
      const stats = NodeFS.statSync(path);
      if (stats.isDirectory() || stats.size === 0) marked.add(stats.ino);
    },
    isMarked: async (path) => marked.has(NodeFS.statSync(path).ino),
  };
};

const makeDatabase = (dbPath: string) => {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO rows (body) VALUES ('kept'), ('also kept');
  `);
  return database;
};

const readRows = (dbPath: string) => {
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return database.prepare("SELECT body FROM rows ORDER BY id").all();
  } finally {
    database.close();
  }
};

it.effect("rewrites an existing copy-on-write database as a No_COW file, once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-no-cow-" });
    const dbPath = path.join(directory, "statev2.sqlite");
    makeDatabase(dbPath).close();
    const attributes = fakeBtrfs();

    assert.isTrue(yield* Effect.promise(() => needsNoCopyOnWriteRewrite(dbPath, attributes)));
    yield* Effect.promise(() => rewriteNoCopyOnWrite(dbPath, 0, attributes));

    assert.isTrue(yield* Effect.promise(() => attributes.isMarked(dbPath)));
    assert.isTrue(yield* Effect.promise(() => attributes.isMarked(directory)));
    assert.deepStrictEqual(readRows(dbPath), [{ body: "kept" }, { body: "also kept" }]);
    assert.isFalse(yield* fs.exists(path.join(directory, ".statev2.sqlite.no-cow")));
    assert.isFalse(yield* Effect.promise(() => needsNoCopyOnWriteRewrite(dbPath, attributes)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves the database untouched while another connection has it open", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-no-cow-open-" });
    const dbPath = path.join(directory, "statev2.sqlite");
    const open = makeDatabase(dbPath);
    const inode = NodeFS.statSync(dbPath).ino;
    const attributes = fakeBtrfs();

    const result = yield* Effect.promise(() =>
      rewriteNoCopyOnWrite(dbPath, 0, attributes).then(
        () => "rewritten",
        () => "refused",
      ),
    );
    open.close();

    assert.strictEqual(result, "refused");
    assert.strictEqual(NodeFS.statSync(dbPath).ino, inode);
    assert.isFalse(yield* Effect.promise(() => attributes.isMarked(directory)));
    assert.deepStrictEqual(readRows(dbPath), [{ body: "kept" }, { body: "also kept" }]);
    assert.isFalse(yield* fs.exists(path.join(directory, ".statev2.sqlite.no-cow")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

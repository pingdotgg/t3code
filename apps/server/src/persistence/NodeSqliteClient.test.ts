import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("preserves the original failure when SQLite automatically rolls back", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE rollback_entries(
          name TEXT UNIQUE ON CONFLICT ROLLBACK
        )
      `;
      yield* sql`INSERT INTO rollback_entries(name) VALUES (${"alpha"})`;

      const error = yield* Effect.flip(
        sql.withTransaction(sql`INSERT INTO rollback_entries(name) VALUES (${"alpha"})`),
      );
      assert.equal(error.reason.operation, "execute");
      assert.include(String(error.reason.cause), "UNIQUE constraint failed");

      yield* sql.withTransaction(sql`INSERT INTO rollback_entries(name) VALUES (${"beta"})`);
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM rollback_entries ORDER BY name
      `;
      assert.deepEqual(
        rows.map((row) => row.name),
        ["alpha", "beta"],
      );
    }),
  );
});

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect("waits for a concurrent writer instead of failing immediately", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sqlite-busy-" });
      const databasePath = path.join(tempDir, "state.sqlite");
      const context = yield* Layer.build(SqliteClient.layer({ filename: databasePath }));
      const sql = yield* Effect.service(SqlClient.SqlClient).pipe(Effect.provide(context));

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;

      const lockHolder = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "-e",
            `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE; INSERT INTO entries(name) VALUES ('child')");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, 300);`,
            databasePath,
          ],
          { extendEnv: true },
        ),
      );
      const locked = yield* lockHolder.stdout.pipe(Stream.decodeText(), Stream.runHead);
      assert.include(Option.getOrThrow(locked), "locked");

      yield* sql.withTransaction(sql`INSERT INTO entries(name) VALUES (${"parent"})`);
      assert.equal(Number(yield* lockHolder.exitCode), 0);

      const rows = yield* sql<{ readonly name: string }>`SELECT name FROM entries ORDER BY id`;
      assert.deepEqual(
        rows.map((row) => row.name),
        ["child", "parent"],
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

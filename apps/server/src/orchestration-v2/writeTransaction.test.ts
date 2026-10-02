import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { withWriteTransaction } from "./writeTransaction.ts";

// A second connection on the same file stands in for a second server process.
const withTwoConnections = <A, E, R>(
  body: (input: {
    readonly sql: SqlClient.SqlClient;
    readonly other: NodeSqlite.DatabaseSync;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-write-transaction-" });
    const filename = path.join(directory, "state.sqlite");
    const other = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (database) => Effect.sync(() => database.close()),
    );
    other.exec("PRAGMA journal_mode = WAL");
    other.exec("PRAGMA busy_timeout = 0");
    other.exec("CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY, value TEXT)");
    return yield* Effect.gen(function* () {
      return yield* body({ sql: yield* SqlClient.SqlClient, other });
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const insertFromOtherProcess = (other: NodeSqlite.DatabaseSync) =>
  Effect.sync(() => {
    try {
      other.exec("INSERT INTO orchestration_events(value) VALUES ('other process')");
      return "committed";
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  });

it.effect(
  "a deferred transaction fails when another process commits between its read and write",
  () =>
    withTwoConnections(({ sql, other }) =>
      Effect.gen(function* () {
        const failure = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT count(*) AS count FROM orchestration_events`;
              assert.equal(yield* insertFromOtherProcess(other), "committed");
              yield* sql`INSERT INTO orchestration_events(value) VALUES ('ours')`;
            }),
          )
          .pipe(Effect.flip);
        assert.include(
          String((failure.reason as { cause?: { message?: unknown } }).cause?.message),
          "locked",
        );
      }),
    ),
);

it.effect("a write transaction holds the write lock from its first read", () =>
  withTwoConnections(({ sql, other }) =>
    Effect.gen(function* () {
      yield* withWriteTransaction(
        sql,
        Effect.gen(function* () {
          yield* sql`SELECT count(*) AS count FROM orchestration_events`;
          assert.include(yield* insertFromOtherProcess(other), "database is locked");
          yield* sql`INSERT INTO orchestration_events(value) VALUES ('ours')`;
        }),
      );
      assert.equal(yield* insertFromOtherProcess(other), "committed");
      assert.deepEqual(
        yield* sql`SELECT value FROM orchestration_events ORDER BY sequence`.values,
        [["ours"], ["other process"]],
      );
    }),
  ),
);

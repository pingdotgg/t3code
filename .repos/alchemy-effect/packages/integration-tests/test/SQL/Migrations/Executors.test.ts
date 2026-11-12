import {
  makeStatementExecutor,
  MigrationError,
  migrationError,
  rowsFromCells,
  withPgClient,
} from "@alchemy.run/sql/Migrations";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

const tags = { tags: ["unit", "local"] };

/** A statement executor that records each request it would send. */
const recording = (dialect: "postgres" | "mysql", batch: "transaction" | "atomic") => {
  const sent: string[] = [];
  const executor = makeStatementExecutor({
    dialect,
    batch,
    execute: (sql) => Effect.sync(() => (sent.push(sql), [{ ok: "1" }])),
  });
  return { executor, sent };
};

describe("makeStatementExecutor", () => {
  it.effect(
    "inlines query params for the dialect",
    () =>
      Effect.gen(function* () {
        const pg = recording("postgres", "atomic");
        expect(yield* pg.executor.query("SELECT $1, $2", ["it's", 3])).toEqual([{ ok: "1" }]);
        const mysql = recording("mysql", "atomic");
        yield* mysql.executor.query("SELECT ?", ["x"]);
        expect([...pg.sent, ...mysql.sent]).toEqual(["SELECT 'it''s', 3", "SELECT 'x'"]);
      }),
    tags,
  );

  it.effect(
    "sends a batch as one request, in a transaction when asked",
    () =>
      Effect.gen(function* () {
        const pg = recording("postgres", "transaction");
        yield* pg.executor.batch(["CREATE TABLE a (id int)", "INSERT INTO a VALUES (1);"]);
        const mysql = recording("mysql", "transaction");
        yield* mysql.executor.batch(["CREATE TABLE a (id int)"]);
        const atomic = recording("postgres", "atomic");
        yield* atomic.executor.batch(["SELECT 1", "SELECT 2"]);
        expect(pg.sent).toEqual([
          "BEGIN;\nCREATE TABLE a (id int);\nINSERT INTO a VALUES (1);\nCOMMIT;",
        ]);
        expect(mysql.sent).toEqual(["START TRANSACTION;\nCREATE TABLE a (id int);\nCOMMIT;"]);
        expect(atomic.sent).toEqual(["SELECT 1;\nSELECT 2;"]);
      }),
    tags,
  );
});

describe("rowsFromCells", () => {
  it.effect(
    "keys cells by column and maps nullValue to null",
    () =>
      Effect.sync(() => {
        expect(
          rowsFromCells(
            [{ name: "name" }, { name: "hash" }],
            [{ values: [{ value: "0001.sql" }, { nullValue: true }] }],
          ),
        ).toEqual([{ name: "0001.sql", hash: null }]);
        expect(rowsFromCells(undefined, undefined)).toEqual([]);
      }),
    tags,
  );
});

describe("migrationError", () => {
  it.effect(
    "names the failing step and keeps the cause",
    () =>
      Effect.sync(() => {
        const tagged = { _tag: "Forbidden", message: "permission denied" };
        const error = migrationError("executeSql on app")(tagged);
        expect(error._tag).toEqual("MigrationError");
        expect(error.message).toEqual("executeSql on app failed: permission denied");
        expect(error.cause).toBe(tagged);
        expect(migrationError("x")({ _tag: "Timeout" }).message).toEqual("x failed: Timeout");
      }),
    tags,
  );
});

describe("withPgClient", () => {
  // Real sockets and real retry spacing: the live clock.
  it.live(
    "retries only the connect while asked, then rewrites the final failure",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        let used = false;
        const error = yield* withPgClient(
          // Nothing listens on port 1: the connect is refused at once.
          { host: "127.0.0.1", port: 1, user: "u", database: "d", connectionTimeoutMillis: 2_000 },
          () => Effect.sync(() => void (used = true)),
          {
            retryConnect: {
              while: (cause) => {
                attempts++;
                return (cause as { code?: unknown }).code === "ECONNREFUSED";
              },
              times: 2,
              interval: "10 millis",
            },
            onConnectFailure: (failure) =>
              new MigrationError({ message: `hinted: ${failure.message}`, cause: failure.cause }),
          },
        ).pipe(Effect.flip);
        // The first attempt plus `times: 2` retries.
        expect(attempts).toEqual(3);
        expect(used).toEqual(false);
        expect(error.message).toContain("hinted: Connecting to postgres at 127.0.0.1 failed");
      }),
    tags,
  );
});

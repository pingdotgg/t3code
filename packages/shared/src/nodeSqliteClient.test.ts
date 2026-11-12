import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const workerMessages = vi.hoisted(
  () => new WeakMap<NodeWorkerThreads.Worker, Array<Record<string, unknown>>>(),
);
const workerReplies = vi.hoisted(
  () => new WeakMap<NodeWorkerThreads.Worker, Array<Record<string, unknown>>>(),
);
// Holds every COMMIT sent to a worker until released, and answers the next one with an error.
const commitHold = vi.hoisted(() => ({
  on: false,
  held: [] as Array<() => void>,
  failNext: false,
}));
// Holds the reply to any request whose SQL mentions "hold-reply" until released, and tells a waiter.
const replyHold = vi.hoisted(() => ({
  ids: new Set<number>(),
  held: [] as Array<() => void>,
  waiters: [] as Array<() => void>,
}));
// Whether a worker keeps the process alive, as the client last told it, and that state at each reply.
const workerRefd = vi.hoisted(() => new WeakMap<NodeWorkerThreads.Worker, boolean>());
const refdAtReply = vi.hoisted(() => new Map<number, boolean>());
// Whether a reply was awaited: the client lets go of the worker while handling the last awaited one.
const awaitedAtReply = vi.hoisted(() => new Map<number, boolean>());
const unrefDuring = vi.hoisted(() => ({ emit: false }));
// The worker's reference state at the moment each ending (ROLLBACK) was posted, by request id.
const refdAtEnding = vi.hoisted(() => new Map<number, boolean>());
// Makes every reader announce itself without a statement authorizer, or (untracked) also answer
// without the connection's transaction state, as on a Node without `isTransaction`.
const readyRewrite = vi.hoisted(() => ({ unguarded: false, untracked: false }));
// Resolves a waiter when a request whose SQL mentions its needle is posted to a worker.
const postWaiters = vi.hoisted(() => [] as Array<{ needle: string; resolve: () => void }>);
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(
        ...((silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
      workerMessages.set(this, []);
      workerReplies.set(this, []);
      this.on("message", (reply) => {
        if (typeof reply === "object" && reply !== null) workerReplies.get(this)!.push(reply);
      });
    }
    override postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      const [request] = args;
      if (typeof request === "object" && request !== null) {
        workerMessages.get(this)!.push(request as Record<string, unknown>);
        if ("sql" in request && String(request.sql).includes("hold-reply"))
          replyHold.ids.add(request.id as number);
        if ("sql" in request && /^\s*ROLLBACK/i.test(String(request.sql)))
          refdAtEnding.set(request.id as number, workerRefd.get(this) ?? true);
        for (const waiter of postWaiters.splice(0)) {
          if ("sql" in request && String(request.sql).includes(waiter.needle)) waiter.resolve();
          else postWaiters.push(waiter);
        }
        if ("sql" in request && /^\s*COMMIT\b/i.test(String(request.sql)) && commitHold.on) {
          if (commitHold.failNext) {
            commitHold.failNext = false;
            this.emit("message", {
              id: request.id,
              error: { operation: "execute", message: "commit answered with an error" },
            });
          }
          commitHold.held.push(() => super.postMessage(...args));
          return;
        }
      }
      super.postMessage(...args);
    }
    override ref() {
      workerRefd.set(this, true);
      return super.ref();
    }
    override unref() {
      workerRefd.set(this, false);
      unrefDuring.emit = true;
      return super.unref();
    }
    override emit(event: string | symbol, ...args: Array<any>): boolean {
      const reply = args[0];
      if (
        event === "message" &&
        readyRewrite.untracked &&
        typeof reply === "object" &&
        reply !== null &&
        "inTransaction" in reply
      ) {
        const untracked = { ...reply };
        delete untracked.inTransaction;
        return this.emit(event, untracked);
      }
      if (
        event === "message" &&
        typeof reply === "object" &&
        reply !== null &&
        typeof reply.id === "number" &&
        !replyHold.ids.has(reply.id)
      ) {
        refdAtReply.set(reply.id, workerRefd.get(this) ?? true);
        unrefDuring.emit = false;
        const delivered = super.emit(event, ...args);
        awaitedAtReply.set(reply.id, unrefDuring.emit);
        return delivered;
      }
      if (
        event === "message" &&
        (readyRewrite.unguarded || readyRewrite.untracked) &&
        reply?.type === "ready"
      )
        return super.emit(event, {
          ...reply,
          guarded: false,
          ...(readyRewrite.untracked ? { tracked: false } : {}),
        });
      if (
        event === "message" &&
        typeof reply === "object" &&
        reply !== null &&
        replyHold.ids.has(reply.id)
      ) {
        replyHold.ids.delete(reply.id);
        replyHold.held.push(() => super.emit(event, ...args));
        for (const waiter of replyHold.waiters.splice(0)) waiter();
        return true;
      }
      return super.emit(event, ...args);
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("records the writer connection owner on a waiting query", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          sql`SELECT 1`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(Effect.withSpan("test.writerHolder"), Effect.forkChild);
      yield* Deferred.await(held);

      const waitingSpan = yield* Deferred.make<Tracer.Span>();
      const observeWaiter: Statement.Transformer = (statement, _sql, _fiber, span) =>
        Deferred.succeed(waitingSpan, span).pipe(Effect.as(statement));
      const waiter = yield* sql`SELECT 1`.pipe(
        Effect.provideService(Statement.CurrentTransformer, observeWaiter),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        (effect) => Effect.forkChild(effect, { startImmediately: true }),
      );
      const span = yield* Deferred.await(waitingSpan);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(waiter);

      assert.equal(span.attributes.get("db.lock_owner_at_start.name"), "test.writerHolder");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.fiber_id"), "number");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.trace_id"), "string");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.span_id"), "string");
    }),
  );

  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
});

const largeText = "x".repeat(64 * 1024 + 1);

it.effect("reads integers on the values path as the caller asked, cached or not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const value of ["small", largeText]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // Deferred BEGIN permits a competing commit, causing SQLITE_BUSY_SNAPSHOT that no timeout can resolve.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("waits for another process's lock while the database opens", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-open-" });
    const filename = path.join(directory, "state.sqlite");
    const seed = new NodeSqlite.DatabaseSync(filename);
    seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries(name TEXT NOT NULL)");
    seed.close();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const holder = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        `const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
        db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
        console.log("held");
        setTimeout(() => db.close(), 300);`,
        filename,
      ]),
    );
    yield* Stream.runHead(holder.stdout);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT COUNT(*) FROM entries`.values, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lets the writer commit while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            // Holding the writer lock here would deadlock this join.
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("serves another read while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      const other = yield* Effect.forkChild(
        Deferred.await(opened).pipe(Effect.andThen(countEntries(sql).pipe(SqliteClient.readOnly))),
      );
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Deferred.succeed(opened, undefined);
            // One shared reader would make this join wait on the transaction forever.
            assert.equal(yield* Fiber.join(other), 1);
          }),
        )
        .pipe(SqliteClient.readOnly);
    }),
  ),
);

// regression: #19226 read-only transactions run on the separate reader connection
it.effect("rejects a write in a read-only transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('blocked')`)
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps the reader read-only even if a statement tries to turn query_only off", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Refused by the reader's authorizer; the open keeps the database read-only anyway.
            yield* sql`PRAGMA query_only = OFF`.pipe(Effect.ignore);
            yield* sql`INSERT INTO entries VALUES ('blocked')`;
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps read-only work inside a write transaction on the writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        const count = yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        assert.equal(count, 2);
      }),
    ),
  ),
);

it.effect.each([
  { nested: false, authorizer: true },
  { nested: true, authorizer: true },
  { nested: false, authorizer: false },
])(
  "fails a read-only transaction whose reader stops, then starts a new reader (nested=$nested, authorizer=$authorizer)",
  ({ nested, authorizer }) =>
    Effect.suspend(() => {
      readyRewrite.unguarded = !authorizer;
      return withReaderClient((sql) =>
        Effect.gen(function* () {
          const startedBefore = startedWorkers.length;
          const body = Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
            return yield* countEntries(sql);
          });
          const error = yield* sql
            .withTransaction(nested ? sql.withTransaction(body) : body)
            .pipe(SqliteClient.readOnly, Effect.flip);

          assert.equal(error._tag, "SqlError");
          assert.include(String(error.reason.cause), "Database reader exited");
          assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
          assert.equal(startedWorkers.length, startedBefore + 2);
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          readyRewrite.unguarded = false;
        }),
      ),
    ),
);

const withFileClient = <A, E>(
  setup: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-off-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      return yield* setup(yield* SqlClient.SqlClient, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("uses the writer when the reader cannot open the database", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);

      // A read beside an open read transaction must not start a worker on the next slot.
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          countEntries(sql).pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(SqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(held);
      const other = yield* countEntries(sql).pipe(SqliteClient.readOnly, (effect) =>
        Effect.forkChild(effect, { startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.equal(yield* Fiber.join(other), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

it.effect("finishes masked database cleanup after its caller is interrupted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cleanup_writes(value INTEGER PRIMARY KEY)`;
    const entered = yield* Deferred.make<void>();
    const work = yield* Effect.forkChild(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO cleanup_writes VALUES (1)`;
            yield* sql.withTransaction(sql`INSERT INTO cleanup_writes VALUES (2)`);
          }),
        ),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(work);
    assert.deepEqual(yield* sql`SELECT value FROM cleanup_writes ORDER BY value`.values, [
      [1],
      [2],
    ]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary that lets the worker's queued messages land, not a wait for time
const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
// Registers now, waits later: the posting of the next request whose SQL mentions the needle.
const posting = (needle: string) => {
  const promise = new Promise<void>((resolve) => postWaiters.push({ needle, resolve }));
  return Effect.promise(() => promise);
};
// Replies a worker has given to the requests whose SQL mentions the needle.
const repliesTo = (worker: NodeWorkerThreads.Worker, needle: string) => {
  const ids = new Set(
    workerMessages
      .get(worker)!
      .filter((message) => String(message.sql ?? "").includes(needle))
      .map((message) => message.id),
  );
  return workerReplies.get(worker)!.filter((reply) => ids.has(reply.id)).length;
};
// A read that keeps a worker busy for a while (a recursive count), tagged in its rows.
const longRead = (tag: string, rows: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) SELECT count(*) AS n, '${tag}' AS tag FROM c`;
// The failure an effect ends with (a success fails the test), typed as its error.
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) return assert.fail("expected a failure");
    return Cause.squash(exit.cause) as E;
  });

it.effect.each([
  { reservation: false, masked: false },
  { reservation: false, masked: true },
  { reservation: true, masked: false },
  { reservation: true, masked: true },
])(
  "preserves caller cancellation while waiting (reservation=$reservation, masked=$masked)",
  ({ reservation, masked }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value INTEGER)`;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(held);
      const entered = yield* Deferred.make<void>();
      const body = sql`INSERT INTO entries VALUES (1)`.pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
      );
      const acquire = reservation
        ? Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* sql.reserve;
              yield* connection.executeUnprepared("INSERT INTO entries VALUES (1)", [], undefined);
              yield* Deferred.succeed(entered, undefined);
            }),
          )
        : sql.withTransaction(body);
      const waiter = yield* Effect.forkChild(masked ? Effect.uninterruptible(acquire) : acquire, {
        startImmediately: true,
      });
      const cancelled = yield* Effect.forkChild(Fiber.interrupt(waiter), {
        startImmediately: true,
      });
      yield* Effect.gen(function* () {
        yield* eventLoopTurn;
        assert.equal(cancelled.pollUnsafe() !== undefined, !masked);
        assert.isFalse(yield* Deferred.isDone(entered));
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(holder);
      yield* Fiber.join(cancelled);
      assert.equal(yield* Deferred.isDone(entered), masked);
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`);
      assert.deepEqual(
        yield* sql`SELECT value FROM entries ORDER BY value`.values,
        masked ? [[1], [2]] : [[2]],
      );
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

// Messages a worker received: the statement's first word, with "begin+" for a folded BEGIN.
const messageShapes = (worker: NodeWorkerThreads.Worker) =>
  workerMessages
    .get(worker)!
    .map(
      (message) =>
        `${message.begin === true ? "begin+" : ""}${String(message.sql).trim().split(/\s+/)[0]}`,
    );

it.effect(
  "sends a read transaction's BEGIN with its first statement and nothing for an empty one",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const before = startedWorkers.length;
        yield* sql.withTransaction(Effect.void).pipe(SqliteClient.readOnly);
        const counts = yield* sql
          .withTransaction(Effect.all([countEntries(sql), countEntries(sql)]))
          .pipe(SqliteClient.readOnly);
        assert.deepEqual(counts, [1, 1]);
        // The COMMIT leaves for the worker on the next turn, after the transaction already ended.
        yield* eventLoopTurn;
        const worker = startedWorkers[before]!;
        assert.deepEqual(messageShapes(worker), ["begin+SELECT", "SELECT", "COMMIT"]);
        // A read after the transaction starts no transaction of its own.
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
        yield* eventLoopTurn;
        assert.deepEqual(messageShapes(worker).slice(3), ["SELECT"]);
      }),
    ),
);

it.effect("finishes a read transaction without waiting for COMMIT and ignores its error", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      commitHold.on = true;
      commitHold.failNext = true;
      try {
        const count = yield* sql
          .withTransaction(countEntries(sql))
          .pipe(SqliteClient.readOnly, Effect.exit);
        // Completed before the COMMIT even left for the worker; held back there, its error reply
        // is ignored.
        assert.deepEqual(count, Exit.succeed(1));
        // The COMMIT leaves at once, still unanswered when the transaction has ended.
        assert.lengthOf(commitHold.held, 1);
        assert.deepEqual(messageShapes(startedWorkers[before]!), ["begin+SELECT", "COMMIT"]);
      } finally {
        commitHold.on = false;
        for (const release of commitHold.held.splice(0)) release();
      }
      // The worker is in sync again once the COMMIT reaches it.
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect(
  "answers a duplicate BEGIN and a COMMIT with no transaction with SQLite's error, bookkeeping intact",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const before = startedWorkers.length;
        const duplicate = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              assert.equal(yield* countEntries(sql), 1);
              return yield* sql.unsafe("BEGIN").pipe(Effect.flip);
            }),
          )
          .pipe(SqliteClient.readOnly);
        assert.include(String(duplicate.reason.cause), "within a transaction");
        // The reader is still usable: the next read transaction starts and ends as always.
        assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
        yield* eventLoopTurn;
        assert.deepEqual(messageShapes(startedWorkers[before]!), [
          "begin+SELECT",
          "BEGIN",
          "COMMIT",
          "begin+SELECT",
          "COMMIT",
        ]);
        // A COMMIT with no transaction to end is answered, not dropped.
        const stray = yield* sql.unsafe("COMMIT").pipe(SqliteClient.readOnly, Effect.flip);
        assert.include(String(stray.reason.cause), "no transaction is active");
        // Only a plain BEGIN is folded: IMMEDIATE and EXCLUSIVE go to SQLite, which refuses them.
        for (const form of ["BEGIN IMMEDIATE", "BEGIN EXCLUSIVE TRANSACTION"]) {
          const explicit = yield* sql.unsafe(form).pipe(SqliteClient.readOnly, Effect.flip);
          assert.include(String(explicit.reason.cause), "readonly database", form);
        }
        assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
        yield* eventLoopTurn;
        assert.deepEqual(messageShapes(startedWorkers[before]!).slice(6), [
          "BEGIN",
          "BEGIN",
          "begin+SELECT",
          "COMMIT",
        ]);
      }),
    ),
);

it.effect(
  "keeps a read transaction through a nested rollback and answers a missing savepoint with SQLite's error",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const before = startedWorkers.length;
        const outer = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              assert.equal(yield* countEntries(sql), 1);
              // A failed nested transaction rolls back to its savepoint; the outer one goes on.
              const nested = yield* sql.withTransaction(Effect.fail("nested")).pipe(Effect.exit);
              assert.isTrue(Exit.isFailure(nested));
              const duplicate = yield* sql.unsafe("BEGIN").pipe(Effect.flip);
              assert.include(String(duplicate.reason.cause), "within a transaction");
              for (const form of [
                "ROLLBACK TO SAVEPOINT missing",
                "ROLLBACK TRANSACTION TO SAVEPOINT missing",
                "ROLLBACK/*to the savepoint*/TO SAVEPOINT missing",
                "-- a comment first\nROLLBACK TO missing",
              ]) {
                const missing = yield* sql.unsafe(form).pipe(Effect.flip);
                assert.include(String(missing.reason.cause), "no such savepoint", form);
              }
              return yield* countEntries(sql);
            }),
          )
          .pipe(SqliteClient.readOnly);
        assert.equal(outer, 1);
        // The reader is still usable, and only the two transactions carried a BEGIN.
        assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
        yield* eventLoopTurn;
        const shapes = messageShapes(startedWorkers[before]!);
        assert.deepEqual(
          shapes.filter((shape) => shape.startsWith("begin+")),
          ["begin+SELECT", "begin+SELECT"],
          shapes.join(" "),
        );
        assert.include(shapes, "ROLLBACK", shapes.join(" "));
      }),
    ),
);

it.effect("forwards statements that merely start with a transaction keyword to SQLite", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      // SQLite's whitespace is narrower than JavaScript's: a no-break space or a vertical tab is
      // part of the token, not a separator.
      for (const form of [
        "BEGIN2",
        "COMMIT2",
        "BEGIN 1",
        "ROLLBACK x",
        "END 2",
        "BEGIN\u00a0",
        "BEGIN\v",
      ]) {
        const error = yield* sql.unsafe(form).pipe(SqliteClient.readOnly, Effect.flip);
        assert.match(
          String(error.reason.cause),
          /syntax error|unrecognized token/,
          JSON.stringify(form),
        );
      }
      // Inside a transaction too, and the reader stays usable afterwards.
      const inside = yield* sql
        .withTransaction(sql.unsafe("BEGIN2").pipe(Effect.flip))
        .pipe(SqliteClient.readOnly);
      assert.include(String(inside.reason.cause), "syntax error");
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("leaves a transaction control with bindings or a raw result to SQLite", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      // A BEGIN with a binding is SQLite's error, not a folded BEGIN.
      const bound = yield* sql.unsafe("BEGIN", [1]).pipe(SqliteClient.readOnly, Effect.flip);
      assert.include(String(bound.reason.cause), "column index out of range");
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      // Raw controls keep the run() result, as before.
      const raw = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const begun = yield* failureOf(sql.unsafe("BEGIN").raw);
            assert.include(String(begun.reason.cause), "within a transaction");
            assert.equal(yield* countEntries(sql), 1);
            return yield* failureOf(sql.unsafe("RELEASE SAVEPOINT missing").raw);
          }),
        )
        .pipe(SqliteClient.readOnly);
      assert.include(String(raw.reason.cause), "no such savepoint");
      const committed = yield* Effect.gen(function* () {
        yield* sql.unsafe("BEGIN").raw;
        assert.equal(yield* countEntries(sql), 1);
        return yield* sql.unsafe("COMMIT").raw;
      }).pipe(SqliteClient.readOnly);
      assert.deepEqual(committed, { changes: 0, lastInsertRowid: 0 });
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      yield* eventLoopTurn;
      // The raw BEGIN inside the transaction was its first statement, so it carried the folded one.
      const shapes = messageShapes(startedWorkers[before]!);
      assert.deepEqual(
        shapes.filter((shape) => shape.startsWith("begin+")),
        ["begin+SELECT", "begin+BEGIN", "begin+SELECT"],
        shapes.join(" "),
      );
    }),
  ),
);

it.effect("keeps its transaction bookkeeping in step with controls the worker ran itself", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      // A transaction opened raw survives a managed one that cannot start inside it.
      const manual = yield* Effect.gen(function* () {
        yield* sql.unsafe("BEGIN").raw;
        assert.equal(yield* countEntries(sql), 1);
        const managed = yield* sql.withTransaction(countEntries(sql)).pipe(Effect.flip);
        assert.include(String(managed.reason.cause), "within a transaction");
        assert.equal(yield* countEntries(sql), 1);
        return yield* sql.unsafe("COMMIT").raw;
      }).pipe(SqliteClient.readOnly);
      assert.deepEqual(manual, { changes: 0, lastInsertRowid: 0 });
      // A raw COMMIT inside a managed transaction leaves its COMMIT with nothing to end.
      const mixed = yield* failureOf(
        sql
          .withTransaction(
            Effect.gen(function* () {
              assert.equal(yield* countEntries(sql), 1);
              return yield* sql.unsafe("COMMIT").raw;
            }),
          )
          .pipe(SqliteClient.readOnly),
      );
      assert.include(String(mixed.reason.cause), "no transaction is active");
      // A top-level savepoint is a transaction too: the managed one fails, the savepoint survives.
      const savepoint = yield* Effect.gen(function* () {
        yield* sql.unsafe("SAVEPOINT outer");
        const managed = yield* sql.withTransaction(countEntries(sql)).pipe(Effect.flip);
        assert.include(String(managed.reason.cause), "within a transaction");
        return yield* sql.unsafe("RELEASE SAVEPOINT outer");
      }).pipe(SqliteClient.readOnly);
      assert.deepEqual(savepoint, []);
      // And the reader is as usable as ever.
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("leaves transaction controls to SQLite on a reader that cannot report its state", () =>
  Effect.gen(function* () {
    readyRewrite.untracked = true;
    yield* withReaderClient((sql) =>
      Effect.gen(function* () {
        const before = startedWorkers.length;
        // A transaction opened raw survives managed ones that cannot start inside it, empty or not.
        const manual = yield* Effect.gen(function* () {
          yield* sql.unsafe("BEGIN").raw;
          const empty = yield* failureOf(sql.withTransaction(Effect.void));
          assert.include(String(empty.reason.cause), "within a transaction");
          const managed = yield* failureOf(sql.withTransaction(countEntries(sql)));
          assert.include(String(managed.reason.cause), "within a transaction");
          return yield* sql.unsafe("COMMIT").raw;
        }).pipe(SqliteClient.readOnly);
        assert.deepEqual(manual, { changes: 0, lastInsertRowid: 0 });
        // Without the connection's state a BEGIN cannot be folded, so it goes to SQLite alone.
        const worker = startedWorkers[before]!;
        const sent = workerMessages.get(worker)!.length;
        assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
        assert.deepEqual(messageShapes(worker).slice(sent), ["BEGIN", "SELECT", "COMMIT"]);
      }),
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        readyRewrite.untracked = false;
      }),
    ),
  ),
);

it.effect("ignores a reply that arrives after a newer transaction transition", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      // A standalone read whose fiber gives up on it while the worker's reply is held back.
      const abandoned = yield* Effect.forkChild(
        sql`SELECT COUNT(*) AS count /* hold-reply */ FROM entries`.pipe(SqliteClient.readOnly),
        { startImmediately: true },
      );
      yield* Effect.promise(() => new Promise<void>((resolve) => replyHold.waiters.push(resolve)));
      yield* Fiber.interrupt(abandoned);
      const count = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // This read carries the folded BEGIN; the stale reply lands after it.
            assert.equal(yield* countEntries(sql), 1);
            for (const release of replyHold.held.splice(0)) release();
            const duplicate = yield* sql.unsafe("BEGIN").pipe(Effect.flip);
            assert.include(String(duplicate.reason.cause), "within a transaction");
            return yield* countEntries(sql);
          }),
        )
        .pipe(SqliteClient.readOnly);
      assert.equal(count, 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect(
  "forwards a BEGIN while an earlier statement on the same reader is still outstanding",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const [savepoint, begin] = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Ends the managed transaction before it began, leaving the reserved reader idle.
              yield* sql.unsafe("ROLLBACK");
              return yield* Effect.all(
                [
                  sql.unsafe("SAVEPOINT outer").pipe(Effect.exit),
                  sql.unsafe("BEGIN").pipe(Effect.exit),
                ],
                { concurrency: "unbounded" },
              );
            }),
          )
          .pipe(SqliteClient.readOnly);
        assert.isTrue(Exit.isSuccess(savepoint));
        // The BEGIN reached SQLite behind the savepoint, which had opened a transaction.
        assert.isTrue(Exit.isFailure(begin), "BEGIN behind a savepoint");
        // The managed COMMIT ended the savepoint's transaction: the reader is free again.
        assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      }),
    ),
);

it.effect(
  "keeps an interrupted read transaction's reader until the worker has answered what it abandoned",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const before = startedWorkers.length;
        yield* sql.withTransaction(sql`SELECT 1 AS warm`).pipe(SqliteClient.readOnly);
        const worker = startedWorkers[before]!;
        // Abandoned as the first statement (its reply still pending, so the ending is an
        // ordinary awaited statement) and as a later one (the ending itself is awaited).
        for (const [tag, body] of [
          ["long-1", (read: string) => sql.unsafe(read)],
          ["long-2", (read: string) => Effect.andThen(countEntries(sql), sql.unsafe(read))],
        ] as const) {
          const arrived = posting(tag);
          const long = yield* sql
            .withTransaction(body(longRead(tag, 1_500_000)))
            .pipe(SqliteClient.readOnly, (effect) =>
              Effect.forkChild(effect, { startImmediately: true }),
            );
          yield* arrived;
          yield* Fiber.interrupt(long);
          // The interruption completed only once the worker had answered the abandoned read,
          // so the reader it frees is idle, as it was before the ending stopped being awaited.
          assert.equal(repliesTo(worker, tag), 1, tag);
        }
        assert.deepEqual(yield* sql`SELECT ${"short-1"} AS tag`.pipe(SqliteClient.readOnly), [
          { tag: "short-1" },
        ]);
      }),
    ),
);

it.effect("leaves no abandoned statement unanswered behind a run of interrupted transactions", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      yield* sql.withTransaction(sql`SELECT 1 AS warm`).pipe(SqliteClient.readOnly);
      const worker = startedWorkers[before]!;
      for (let i = 0; i < 5; i++) {
        const arrived = posting(`pile-${i}`);
        const fiber = yield* sql
          .withTransaction(sql.unsafe(longRead(`pile-${i}`, 500_000)))
          .pipe(SqliteClient.readOnly, (effect) =>
            Effect.forkChild(effect, { startImmediately: true }),
          );
        yield* arrived;
        yield* Fiber.interrupt(fiber);
      }
      const unanswered = [0, 1, 2, 3, 4].filter((i) => repliesTo(worker, `pile-${i}`) === 0);
      assert.deepEqual(unanswered, [], "abandoned reads still queued on the worker");
      assert.deepEqual(yield* sql`SELECT ${"after"} AS tag`.pipe(SqliteClient.readOnly), [
        { tag: "after" },
      ]);
    }),
  ),
);

it.effect(
  "answers a duplicate BEGIN issued beside a transaction's first statement with SQLite's error",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const [count, duplicate] = yield* sql
          .withTransaction(
            Effect.all([countEntries(sql), failureOf(sql.unsafe("BEGIN"))], {
              concurrency: "unbounded",
            }),
          )
          .pipe(SqliteClient.readOnly);
        assert.equal(count, 1);
        assert.include(String(duplicate.reason.cause), "within a transaction");
        assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      }),
    ),
);

it.effect("ends a transaction the worker reopened raw while a plain BEGIN was folded", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const plain = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            assert.equal(yield* countEntries(sql), 1);
            yield* sql.unsafe("COMMIT").raw;
            const raw = yield* Effect.forkChild(sql.unsafe("BEGIN").raw, {
              startImmediately: true,
            });
            const plain = yield* sql.unsafe("BEGIN").pipe(Effect.exit);
            yield* Fiber.join(raw);
            return plain;
          }),
        )
        .pipe(SqliteClient.readOnly);
      // The plain BEGIN reached SQLite behind the raw one; the managed COMMIT ended that one.
      assert.isTrue(Exit.isFailure(plain), "plain BEGIN behind a raw one");
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("folds and ends a transaction whose controls carry comments", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      yield* sql.withTransaction(sql`SELECT 1 AS warm`).pipe(SqliteClient.readOnly);
      const count = yield* Effect.gen(function* () {
        yield* sql.unsafe("/* deferred */ BEGIN");
        const count = yield* countEntries(sql);
        yield* sql.unsafe("COMMIT -- done");
        return count;
      }).pipe(SqliteClient.readOnly);
      assert.equal(count, 1);
      yield* eventLoopTurn;
      assert.deepEqual(messageShapes(startedWorkers[before]!).slice(2), ["begin+SELECT", "COMMIT"]);
    }),
  ),
);

it.effect("reports the connection's transaction state on every reply", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            assert.equal(yield* countEntries(sql), 1);
            yield* sql`SELECT name FROM missing_table /* inside-error */`.pipe(Effect.exit);
            yield* sql`SELECT name FROM entries /* inside-rows */`;
          }),
        )
        .pipe(SqliteClient.readOnly);
      yield* sql`SELECT name FROM entries /* outside-rows */`.pipe(SqliteClient.readOnly);
      const worker = startedWorkers[before]!;
      const stateOf = (needle: string) => {
        const ids = new Set(
          workerMessages
            .get(worker)!
            .filter((message) => String(message.sql ?? "").includes(needle))
            .map((message) => message.id),
        );
        return workerReplies
          .get(worker)!
          .filter((reply) => ids.has(reply.id))
          .map((reply) => reply.inTransaction);
      };
      assert.deepEqual(stateOf("inside-error"), [true]);
      assert.deepEqual(stateOf("inside-rows"), [true]);
      assert.deepEqual(stateOf("outside-rows"), [false]);
    }),
  ),
);

it.effect("ignores a reply older than the ending that freed the reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            assert.equal(yield* countEntries(sql), 1);
            // A sibling abandoned by its fiber, its reply (in-transaction) held back.
            const abandoned = yield* Effect.forkChild(
              sql`SELECT name /* hold-reply */ FROM entries`,
              { startImmediately: true },
            );
            yield* Effect.promise(
              () => new Promise<void>((resolve) => replyHold.waiters.push(resolve)),
            );
            yield* Fiber.interrupt(abandoned);
          }),
        )
        .pipe(SqliteClient.readOnly);
      // The ending was awaited behind the abandoned read; its stale reply lands afterwards.
      for (const release of replyHold.held.splice(0)) release();
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      yield* eventLoopTurn;
      const shapes = messageShapes(startedWorkers[before]!);
      assert.deepEqual(shapes.slice(-2), ["begin+SELECT", "COMMIT"], shapes.join(" "));
    }),
  ),
);

it.effect("refuses a write on a reader, temporary tables included", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .unsafe("CREATE TEMP TABLE scratch(x)")
        .pipe(SqliteClient.readOnly, Effect.flip);
      assert.match(String(error.reason.cause), /readonly|query_only|read-only|not authorized/i);
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("keeps a reader from turning its writes back on", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const pragma = yield* sql
        .unsafe("PRAGMA query_only = OFF")
        .pipe(SqliteClient.readOnly, Effect.exit);
      const write = yield* sql
        .unsafe("CREATE TEMP TABLE scratch(x)")
        .pipe(SqliteClient.readOnly, Effect.flip);
      assert.match(String(write.reason.cause), /readonly|query_only|read-only|not authorized/i);
      assert.isTrue(Exit.isFailure(pragma), "query_only stays on");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("refuses what the read-only open does not, whatever the spelling or the database", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const pragma = yield* sql
        .unsafe("PRAGMA QUERY_ONLY = OFF")
        .pipe(SqliteClient.readOnly, Effect.exit);
      assert.isTrue(Exit.isFailure(pragma), "query_only stays on, whatever the spelling");
      const write = yield* sql
        .unsafe("CREATE TEMP TABLE scratch(x)")
        .pipe(SqliteClient.readOnly, Effect.flip);
      assert.match(String(write.reason.cause), /readonly|query_only|read-only|not authorized/i);
      const attach = yield* sql
        .unsafe("ATTACH DATABASE 'file:extra?mode=memory' AS extra")
        .pipe(SqliteClient.readOnly, Effect.flip);
      assert.include(String(attach.reason.cause), "not authorized");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("awaits a read transaction's ending on a reader without an authorizer", () =>
  Effect.gen(function* () {
    readyRewrite.unguarded = true;
    commitHold.on = true;
    try {
      yield* withReaderClient((sql) =>
        Effect.gen(function* () {
          const committing = posting("COMMIT");
          const fiber = yield* sql
            .withTransaction(countEntries(sql))
            .pipe(SqliteClient.readOnly, (effect) =>
              Effect.forkChild(effect, { startImmediately: true }),
            );
          yield* committing;
          yield* eventLoopTurn;
          // Without an authorizer a write could have happened, so the ending's answer is waited for.
          assert.isUndefined(fiber.pollUnsafe(), "ended before the COMMIT was answered");
          commitHold.on = false;
          for (const release of commitHold.held.splice(0)) release();
          assert.equal(yield* Fiber.join(fiber), 1);
          assert.equal(
            yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
            1,
          );
        }),
      );
    } finally {
      readyRewrite.unguarded = false;
      commitHold.on = false;
      for (const release of commitHold.held.splice(0)) release();
    }
  }),
);

it.effect("sets up an awaited ending correctly whatever happens before it runs", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      // Several yield budgets, so that the gap before the ending's callback falls at a turn
      // boundary under at least one alignment.
      for (const happening of ["the abandoned reply arrives", "the worker stops"] as const) {
        for (const budget of [3, 4, 5, 6, 7]) {
          const turns = Effect.provideService(Scheduler.MaxOpsBeforeYield, budget);
          for (let yields = 0; yields < 24; yields++) {
            yield* sql.withTransaction(sql`SELECT 1 AS warm`).pipe(SqliteClient.readOnly);
            const worker = startedWorkers.at(-1)!;
            const held = new Promise<void>((resolve) => replyHold.waiters.push(resolve));
            // The transaction abandons a read whose reply is held, then ends: with a one-step
            // budget every step of its ending, including the gap before its callback, is a turn.
            const transaction = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const abandoned = yield* Effect.forkChild(
                    sql`SELECT name /* hold-reply */ FROM entries`,
                    { startImmediately: true },
                  );
                  yield* Effect.promise(() => held);
                  yield* Fiber.interrupt(abandoned);
                }),
              )
              .pipe(SqliteClient.readOnly, turns, (effect) =>
                Effect.forkChild(effect, { startImmediately: true }),
              );
            yield* Effect.promise(() => held);
            for (let i = 0; i < yields; i++) yield* Effect.yieldNow;
            if (happening === "the abandoned reply arrives")
              for (const release of replyHold.held.splice(0)) release();
            else worker.emit("exit", 1);
            // The transaction ends either way, and never hangs.
            yield* Fiber.join(transaction).pipe(Effect.exit);
            for (const release of replyHold.held.splice(0)) release();
            if (happening === "the abandoned reply arrives") {
              // An ending left as the only pending request keeps the worker referenced.
              const ending = workerMessages
                .get(worker)!
                .findLast((message) => /^\s*COMMIT/i.test(String(message.sql ?? "")));
              if (ending !== undefined && awaitedAtReply.get(ending.id as number))
                assert.isTrue(
                  refdAtReply.get(ending.id as number),
                  `after ${yields} yields: the worker was let go of before its ending was answered`,
                );
            } else {
              yield* Effect.promise(() => worker.terminate());
            }
          }
        }
      }
    }),
  ),
);

it.effect(
  "answers an awaited ending with SQLite's error when a control it waited behind ended first",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const outer = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              assert.equal(yield* countEntries(sql), 1);
              // The raw COMMIT is still outstanding when the plain one leaves, so that one waits
              // for its answer: SQLite's, not a guess.
              const [raw, plain] = yield* Effect.all(
                [
                  sql.unsafe("COMMIT").raw.pipe(Effect.exit),
                  sql.unsafe("COMMIT").pipe(Effect.exit),
                ],
                { concurrency: "unbounded" },
              );
              assert.isTrue(Exit.isSuccess(raw));
              assert.isTrue(Exit.isFailure(plain), "the second COMMIT had nothing to end");
              if (Exit.isFailure(plain))
                assert.include(
                  String(
                    (Cause.squash(plain.cause) as { reason: { cause: unknown } }).reason.cause,
                  ),
                  "no transaction is active",
                );
            }),
          )
          .pipe(SqliteClient.readOnly, Effect.exit);
        // The managed COMMIT has nothing to end either.
        assert.isTrue(Exit.isFailure(outer));
        assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      }),
    ),
);

it.effect("answers an awaited ending behind an outstanding raw COMMIT with SQLite's error", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      // The raw COMMIT's reply is held back, so the managed COMMIT behind it takes the awaited
      // path for certain; SQLite answers that one with "no transaction is active".
      const exit = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            assert.equal(yield* countEntries(sql), 1);
            yield* Effect.forkChild(sql.unsafe("COMMIT /* hold-reply */").raw, {
              startImmediately: true,
            });
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.exit);
      for (const release of replyHold.held.splice(0)) release();
      assert.isTrue(Exit.isFailure(exit), "the managed COMMIT had nothing to end");
      if (Exit.isFailure(exit))
        assert.include(
          String((Cause.squash(exit.cause) as { reason: { cause: unknown } }).reason.cause),
          "no transaction is active",
        );
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect(
  "keeps its bookkeeping and the worker through a reply landing before an awaited ending runs",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const before = startedWorkers.length;
        yield* countEntries(sql).pipe(SqliteClient.readOnly);
        const worker = startedWorkers[before]!;
        // A scheduler of the test's own releases the held reply at the k-th turn; with a yield
        // budget of three, one of those turns is the gap before the awaited ending's callback.
        let releaseAt = -1;
        let turns = 0;
        const hooked = new Scheduler.MixedScheduler("async", (task) => {
          const timer = setImmediate(() => {
            if (releaseAt >= 0 && turns++ === releaseAt)
              for (const release of replyHold.held.splice(0)) release();
            task();
          });
          return () => clearImmediate(timer);
        });
        for (let k = 0; k < 24; k++) {
          releaseAt = -1;
          turns = 0;
          const seen = workerMessages.get(worker)!.length;
          const held = new Promise<void>((resolve) => replyHold.waiters.push(resolve));
          const fiber = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* countEntries(sql);
                yield* sql`SELECT 1 AS x /* hold-reply */`;
              }),
            )
            .pipe(
              SqliteClient.readOnly,
              Effect.provideService(Scheduler.MaxOpsBeforeYield, 3),
              Effect.provideService(Scheduler.Scheduler, hooked),
              (effect) => Effect.forkChild(effect, { startImmediately: true }),
            );
          yield* Effect.promise(() => held);
          releaseAt = k;
          yield* Fiber.interrupt(fiber);
          for (const release of replyHold.held.splice(0)) release();
          assert.equal(
            yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
            1,
          );
          yield* eventLoopTurn;
          const messages = workerMessages.get(worker)!.slice(seen);
          const ending = messages.findIndex((message) => /^\s*ROLLBACK/i.test(String(message.sql)));
          assert.notEqual(ending, -1, `k=${k}: no ending`);
          // The next transaction still folds its BEGIN: the ending left no restored flag behind.
          const shapes = messageShapes(worker).slice(seen);
          assert.equal(shapes[ending + 1], "begin+SELECT", `k=${k}: ${shapes.join(" ")}`);
          // And while the ending was awaited, the worker stayed referenced.
          const endingId = messages[ending]!.id as number;
          if (awaitedAtReply.get(endingId))
            assert.isTrue(
              refdAtEnding.get(endingId),
              `k=${k}: the worker was let go of while its ending was awaited`,
            );
        }
      }),
    ),
);

// A scheduler that yields as its fiber's budget says and, at the k-th task it schedules once armed,
// runs a hook first.
const steppingScheduler = (k: number, hook: () => void) => {
  const base = new Scheduler.MixedScheduler();
  const state = { armed: false, tasks: 0 };
  const scheduler: Scheduler.Scheduler = {
    executionMode: base.executionMode,
    shouldYield: (fiber) => base.shouldYield(fiber),
    makeDispatcher: () => {
      const inner = base.makeDispatcher();
      return {
        scheduleTask: (task, priority) => {
          if (state.armed && state.tasks++ === k) hook();
          inner.scheduleTask(task, priority);
        },
        flush: () => inner.flush(),
      };
    },
  };
  return { scheduler, arm: () => (state.armed = true) };
};

it.effect("keeps its bookkeeping when a sibling statement leaves before an awaited ending", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      // The sibling leaves at the k-th turn of the transaction's fiber, for every turn of its ending,
      // under several yield budgets so that a turn boundary falls inside each step of the ending.
      for (const budget of [3, 4, 5, 6, 7])
        for (let k = 0; ; k++) {
          assert.isBelow(k, 400, "the ending never finished");
          assert.equal(
            yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
            1,
          );
          const worker = startedWorkers.at(-1)!;
          const held = new Promise<void>((resolve) => replyHold.waiters.push(resolve));
          let sibling: Fiber.Fiber<number | undefined, unknown> | undefined;
          let release: (() => void) | undefined;
          let fired = false;
          const stepping = steppingScheduler(k, () => {
            const run = release;
            release = undefined;
            fired = run !== undefined;
            run?.();
          });
          const transaction = sql
            .withTransaction(
              Effect.gen(function* () {
                // An answered read tells the client it is in a transaction; a read whose reply is
                // held back then keeps the transaction's ending awaited.
                assert.equal(yield* countEntries(sql), 1);
                yield* Effect.forkChild(sql`SELECT name /* hold-reply */ FROM entries`, {
                  startImmediately: true,
                });
                yield* Effect.promise(() => held);
                // The sibling waits on its own fiber, with an ordinary scheduler, and once released
                // runs its statement up to the post without yielding.
                const gate = Deferred.makeUnsafe<void>();
                sibling = yield* Effect.forkChild(
                  Deferred.await(gate).pipe(
                    Effect.andThen(countEntries(sql)),
                    Effect.provideService(Scheduler.MaxOpsBeforeYield, 2048),
                    Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
                  ),
                  { startImmediately: true },
                );
                release = () => Deferred.doneUnsafe(gate, Effect.void);
                stepping.arm();
              }),
            )
            .pipe(
              SqliteClient.readOnly,
              Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
              Effect.provideService(Scheduler.Scheduler, stepping.scheduler),
            );
          // Its own fiber, so that it schedules through the stepping scheduler from the start.
          yield* Fiber.await(yield* Effect.forkChild(transaction, { startImmediately: true }));
          for (const reply of replyHold.held.splice(0)) reply();
          if (sibling !== undefined) yield* Fiber.await(sibling);
          yield* eventLoopTurn;
          // The worker has ended the transaction: a stray COMMIT gets SQLite's error, and the next
          // read transaction folds its BEGIN again.
          const stray = yield* sql.unsafe("COMMIT").pipe(
            SqliteClient.readOnly,
            Effect.match({
              onFailure: (error) => String(error.reason.cause),
              onSuccess: () => "the stray COMMIT succeeded",
            }),
          );
          assert.include(
            stray,
            "no transaction is active",
            `sibling at turn ${k}, budget ${budget}`,
          );
          assert.equal(
            yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
            1,
          );
          yield* eventLoopTurn;
          assert.deepEqual(
            messageShapes(worker).slice(-2),
            ["begin+SELECT", "COMMIT"],
            `sibling at turn ${k}, budget ${budget}`,
          );
          if (!fired) break;
        }
    }),
  ),
);

it.effect("reads the temporary schema's metadata on a reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* sql.unsafe("PRAGMA temp.table_info(entries)").pipe(SqliteClient.readOnly),
        [],
      );
      assert.lengthOf(yield* sql.unsafe("PRAGMA temp.page_count").pipe(SqliteClient.readOnly), 1);
      const pragma = yield* sql
        .unsafe("PRAGMA temp.query_only = OFF")
        .pipe(SqliteClient.readOnly, Effect.flip);
      assert.include(String(pragma.reason.cause), "not authorized");
    }),
  ),
);

it.effect("lets a process exit cleanly after a one-shot read transaction", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-exit-" });
    const filename = path.join(directory, "state.sqlite");
    const seed = new NodeSqlite.DatabaseSync(filename);
    seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries(name TEXT NOT NULL)");
    seed.close();
    // The reply that answers the read resumes the fiber, whose scope then terminates the worker;
    // a worker let go of after that leaves nothing to keep the process alive (exit code 13). The
    // script lives beside the client so that its bare imports resolve.
    const script = path.join(import.meta.dirname, `.exit-probe-${process.pid}.mjs`);
    yield* Effect.acquireRelease(
      fs.writeFileString(
        script,
        `import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "./nodeSqliteClient.ts";
await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(sql\`SELECT COUNT(*) AS count FROM entries\`).pipe(SqliteClient.readOnly);
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: process.argv[2], readerWorker: true })),
    Effect.scoped,
  ),
);
console.log("done");
`,
      ),
      () => fs.remove(script).pipe(Effect.ignore),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["--no-warnings", script, filename]),
    );
    const decoder = new TextDecoder();
    const output = yield* Stream.runFold(
      child.stdout,
      () => "",
      (text, chunk) => text + decoder.decode(chunk),
    );
    const errors = yield* Stream.runFold(
      child.stderr,
      () => "",
      (text, chunk) => text + decoder.decode(chunk),
    );
    const exitCode = yield* child.exitCode;
    assert.equal(exitCode, 0, `exit ${exitCode}: ${errors}`);
    assert.include(output, "done");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("posts statements issued together at once, in order, and answers each on its own", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      const results = yield* sql
        .withTransaction(
          Effect.all(
            [
              countEntries(sql),
              sql`SELECT name FROM missing_table`,
              sql<{ name: string }>`SELECT name FROM entries`,
            ],
            { concurrency: "unbounded", mode: "result" },
          ),
        )
        .pipe(SqliteClient.readOnly);
      assert.deepEqual(results[0], Result.succeed(1));
      assert.isTrue(Result.isFailure(results[1]));
      assert.deepEqual(results[2], Result.succeed([{ name: "first" }]));
      yield* eventLoopTurn;
      // One message per statement, in order, the BEGIN with the first.
      assert.deepEqual(messageShapes(startedWorkers[before]!), [
        "begin+SELECT",
        "SELECT",
        "SELECT",
        "COMMIT",
      ]);
    }),
  ),
);

// A yield budget of three makes a fiber yield after every step (two cannot progress at all: the
// resumption and the yield check use the budget up), so whatever the transaction's fiber does after
// k of its own yields lands at every point of that statement's path, including between the request
// effect being built and its callback running.
const oneStepTurns = Effect.provideService(Scheduler.MaxOpsBeforeYield, 3);

it.effect(
  "keeps a read transaction's BEGIN on the first statement that leaves, whichever fiber yields",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const before = startedWorkers.length;
        let seen = 0;
        for (let yields = 0; yields < 32; yields++) {
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const first = yield* Effect.forkChild(countEntries(sql).pipe(oneStepTurns), {
                  startImmediately: true,
                });
                for (let i = 0; i < yields; i++) yield* Effect.yieldNow;
                const second = yield* Effect.forkChild(countEntries(sql), {
                  startImmediately: true,
                });
                assert.deepEqual([yield* Fiber.join(second), yield* Fiber.join(first)], [1, 1]);
              }),
            )
            .pipe(SqliteClient.readOnly);
          yield* eventLoopTurn;
          const shapes = messageShapes(startedWorkers[before]!).slice(seen);
          seen += shapes.length;
          assert.deepEqual(shapes, ["begin+SELECT", "SELECT", "COMMIT"], `after ${yields} yields`);
        }
      }),
    ),
);

it.effect("never lets an interrupted statement take a read transaction's BEGIN with it", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      let seen = 0;
      for (let yields = 0; yields < 32; yields++) {
        const count = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const first = yield* Effect.forkChild(countEntries(sql).pipe(oneStepTurns), {
                startImmediately: true,
              });
              for (let i = 0; i < yields; i++) yield* Effect.yieldNow;
              yield* Fiber.interrupt(first);
              return yield* countEntries(sql);
            }),
          )
          .pipe(SqliteClient.readOnly);
        assert.equal(count, 1);
        yield* eventLoopTurn;
        const shapes = messageShapes(startedWorkers[before]!).slice(seen);
        seen += shapes.length;
        // The interrupted statement left before the interruption or not at all; either way the
        // BEGIN is on the first message.
        assert.deepInclude(
          [
            ["begin+SELECT", "SELECT", "COMMIT"],
            ["begin+SELECT", "COMMIT"],
          ],
          shapes,
          `after ${yields} yields: ${shapes.join(" ")}`,
        );
      }
    }),
  ),
);

it.effect("fails a statement whose worker stopped before it left instead of waiting forever", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      for (let yields = 0; yields < 64; yields++) {
        // Warm a reader, then stop it after the statement's fiber has taken k steps towards it.
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
        const worker = startedWorkers.at(-1)!;
        const first = yield* Effect.forkChild(
          countEntries(sql).pipe(SqliteClient.readOnly, oneStepTurns),
          { startImmediately: true },
        );
        for (let i = 0; i < yields; i++) yield* Effect.yieldNow;
        // The stop lands at this very step of the statement's path (a termination's exit would
        // arrive turns later, and a second exit would rescue a statement the first one lost).
        worker.emit("exit", 1);
        // Failed with the stopped reader or answered by a fresh one; a statement posted to nobody
        // would never settle here.
        const exit = yield* Fiber.join(first).pipe(Effect.exit);
        yield* Effect.promise(() => worker.terminate());
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause) as { reason: { cause: unknown } };
          assert.include(String(error.reason.cause), "Database reader exited");
        } else {
          assert.equal(exit.value, 1);
        }
      }
    }),
  ),
);

it.effect("answers reader statements with column names and row arrays", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      const rows = yield* sql<{
        name: string;
        one: number;
      }>`SELECT name, 1 AS one FROM entries`.pipe(SqliteClient.readOnly);
      assert.deepEqual(rows, [{ name: "first", one: 1 }]);
      const values = yield* sql`SELECT name, 1 AS one FROM entries`.values.pipe(
        SqliteClient.readOnly,
      );
      assert.deepEqual(values, [["first", 1]]);
      const replies = workerReplies
        .get(startedWorkers[before]!)!
        .filter((reply) => "rows" in reply);
      assert.lengthOf(replies, 2);
      // Both replies carry row arrays; only the object read needs the column names.
      assert.deepEqual(replies[0]!.columns, ["name", "one"]);
      assert.isUndefined(replies[1]!.columns);
      for (const reply of replies) assert.deepEqual(reply.rows, [["first", 1]]);
    }),
  ),
);

it.effect("fails a reader statement with an uncloneable binding and still answers the others", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const [bad, good] = yield* sql
        .withTransaction(
          Effect.all(
            [
              sql.unsafe("SELECT ? AS value", [() => 1]).pipe(Effect.exit),
              countEntries(sql).pipe(Effect.exit),
            ],
            { concurrency: "unbounded" },
          ),
        )
        .pipe(SqliteClient.readOnly);
      assert.isTrue(Exit.isFailure(bad!));
      assert.deepEqual(good, Exit.succeed(1));
      // The worker is still in step afterwards.
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("names the columns of a cached reader statement after a schema change", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = yield* sql`SELECT * FROM entries`.pipe(SqliteClient.readOnly);
      assert.deepEqual(before, [{ name: "first" }]);
      yield* sql`ALTER TABLE entries ADD COLUMN extra TEXT`;
      const after = yield* sql`SELECT * FROM entries`.pipe(SqliteClient.readOnly);
      assert.deepEqual(after, [{ name: "first", extra: null }]);
    }),
  ),
);

it.effect("keeps a reader column named __proto__", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT 7 AS [__proto__], 9 AS ordinary`.pipe(SqliteClient.readOnly);
      assert.deepEqual(Object.entries(rows[0]!), [
        ["__proto__", 7],
        ["ordinary", 9],
      ]);
    }),
  ),
);

it.effect("keeps a read transaction when its first statement cannot be sent", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const unsent = yield* sql.unsafe("SELECT ? AS value", [() => 1]).pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(unsent));
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);
      // Both reads ran inside the transaction's snapshot, which the lost BEGIN would not give.
      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("keeps a read transaction for the siblings of a statement that cannot be sent", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [unsent, before] = yield* Effect.all(
              [sql.unsafe("SELECT ? AS value", [() => 1]).pipe(Effect.exit), countEntries(sql)],
              { concurrency: "unbounded" },
            );
            assert.isTrue(Exit.isFailure(unsent));
            yield* Deferred.succeed(snapshotTaken, undefined);
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);
      // The sibling took the transaction's snapshot, so the later read sees the same rows.
      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

const PAYLOAD = new Uint8Array(1024 * 1024).fill(7);
const WAL_SIZE_LIMIT = 32 * 1024 * 1024;

// Fails instead of hanging when admission holds the write: the worker retries a blocked
// checkpoint on its own, so two blocked reports for one WAL generation mean a held write.
const insertUnlessHeld = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  worker: NodeWorkerThreads.Worker,
  label: string,
) {
  const stalled = yield* Deferred.make<void>();
  let seen: unknown;
  const onMessage = (message: { type?: unknown; blocked?: unknown; generation?: unknown }) => {
    if (message?.type !== "checkpoint" || message.blocked !== true) return;
    if (message.generation === seen) Deferred.doneUnsafe(stalled, Effect.void);
    seen = message.generation;
  };
  worker.on("message", onMessage);
  const held = yield* Effect.raceFirst(
    sql`INSERT INTO blobs VALUES (${PAYLOAD})`.pipe(Effect.as(false)),
    Deferred.await(stalled).pipe(Effect.as(true)),
  ).pipe(Effect.ensuring(Effect.sync(() => worker.off("message", onMessage))));
  if (held) assert.fail(`${label} is held by admission while an outside reader pins the WAL`);
});

// `outside` stands in for `sqlite3 statev2.sqlite` or a backup script reading the database.
const withOutsideConnection = <A, E>(
  use: (options: {
    readonly sql: SqlClient.SqlClient;
    readonly worker: NodeWorkerThreads.Worker;
    readonly outside: NodeSqlite.DatabaseSync;
    readonly walSize: Effect.Effect<number>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-pinned-wal-" });
    const filename = path.join(directory, "state.sqlite");
    const outside = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (db) =>
        Effect.sync(() => {
          if (db.isTransaction) db.exec("COMMIT");
          db.close();
        }),
    );
    outside.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE blobs(data BLOB NOT NULL);
    `);
    const walSize = fs.stat(`${filename}-wal`).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orDie,
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT}`);
      return yield* use({ sql, worker: startedWorkers.at(-1)!, outside, walSize });
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const openReadTransaction = (db: NodeSqlite.DatabaseSync) => {
  db.exec("BEGIN");
  db.prepare("SELECT COUNT(*) FROM blobs").get();
};

it.effect("keeps admitting writes while an outside read transaction pins the WAL", () =>
  withOutsideConnection(({ sql, worker, outside }) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO blobs VALUES (${PAYLOAD})`;
      openReadTransaction(outside);
      // 140 MiB passes both the 32 MiB size limit and the 32,768-frame ceiling.
      for (let write = 1; write <= 140; write++) {
        yield* insertUnlessHeld(sql, worker, `write ${write}`);
      }
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM blobs`;
      assert.equal(rows[0]?.count, 141);
    }),
  ),
);

it.effect("keeps admitting writes while a reader stops TRUNCATE, then resets the WAL", () =>
  withOutsideConnection(({ sql, worker, outside, walSize }) =>
    Effect.gen(function* () {
      const insert = outside.prepare("INSERT INTO blobs VALUES (?)");
      for (let write = 1; write <= 40; write++) insert.run(PAYLOAD);
      // A snapshot of an unbackfilled WAL lets PASSIVE finish but stops TRUNCATE.
      openReadTransaction(outside);
      const stopped = yield* Deferred.make<void>();
      const reset = yield* Deferred.make<void>();
      worker.on("message", (message: { type?: unknown; truncateId?: unknown; log?: unknown }) => {
        if (message?.type !== "checkpoint" || message.truncateId === undefined) return;
        Deferred.doneUnsafe(message.log === 0 ? reset : stopped, Effect.void);
      });
      // Starts a checkpoint without appending a frame past the reader's snapshot.
      yield* sql`DELETE FROM blobs WHERE 0`;
      yield* Deferred.await(stopped);
      yield* insertUnlessHeld(sql, worker, "a write after the failed TRUNCATE");
      assert.isAbove(yield* walSize, WAL_SIZE_LIMIT);
      outside.exec("COMMIT");
      // No further write arrives; the worker has to retry on its own.
      yield* Deferred.await(reset);
      assert.equal(yield* walSize, 0);
    }),
  ),
);

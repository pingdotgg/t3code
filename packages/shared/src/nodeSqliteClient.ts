import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  /** Ignored for in-memory databases, which cannot share a second connection. */
  readonly readerWorker?: boolean | undefined;
  /** Ignored for in-memory databases. */
  readonly checkpointWorker?: boolean | undefined;
}

// SqlClient masks transaction acquisition, so readOnly carries the caller's interruption policy.
const ReadOnly = Context.Reference<typeof Effect.interruptible | undefined>(
  "@t3tools/shared/nodeSqliteClient/ReadOnly",
  { defaultValue: () => undefined },
);

/** Wrap the whole transaction; existing write transactions retain the writer, and writes on the reader fail as readonly. */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    restore(Effect.provideService(effect, ReadOnly, restore)),
  );

interface Acquired {
  readonly connection: "writer" | "reader";
  readonly lockWaitMs: number;
}

interface ConnectionOwner {
  readonly fiberId: number;
  readonly name: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

const connectionOwner = (fiber: Fiber.Fiber<unknown, unknown>): ConnectionOwner => {
  const current = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (current?._tag !== "Span") return { fiberId: fiber.id, name: "untraced" };
  let span: Tracer.Span = current;
  while (span.name === "sqlite" || span.name === "sql.transaction") {
    const parent: Tracer.AnySpan | undefined = Option.getOrUndefined(span.parent);
    if (parent?._tag !== "Span") break;
    span = parent;
  }
  return { fiberId: fiber.id, name: span.name, traceId: span.traceId, spanId: span.spanId };
};

const annotateAcquired = (
  fiber: Fiber.Fiber<unknown, unknown>,
  acquired: Acquired | undefined,
  ownerAtWaitStart?: ConnectionOwner,
) => {
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span?._tag !== "Span" || acquired === undefined) return;
  span.attribute("db.connection", acquired.connection);
  span.attribute("db.lock_wait_ms", acquired.lockWaitMs);
  if (ownerAtWaitStart !== undefined) {
    span.attribute("db.lock_owner_at_start.fiber_id", ownerAtWaitStart.fiberId);
    span.attribute("db.lock_owner_at_start.name", ownerAtWaitStart.name);
    if (ownerAtWaitStart.traceId !== undefined) {
      span.attribute("db.lock_owner_at_start.trace_id", ownerAtWaitStart.traceId);
    }
    if (ownerAtWaitStart.spanId !== undefined) {
      span.attribute("db.lock_owner_at_start.span_id", ownerAtWaitStart.spanId);
    }
  }
};

const TransactionAcquire = Context.Reference<
  | {
      acquired?: Acquired;
      ownerAtWaitStart: ConnectionOwner | undefined;
      restore: typeof Effect.interruptible | undefined;
    }
  | undefined
>("@t3tools/shared/nodeSqliteClient/TransactionAcquire", { defaultValue: () => undefined });

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

const checkNodeSqliteCompat = Effect.fn("checkNodeSqliteCompat")(function () {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
});

// node:sqlite supplies errcode; classifySqliteError expects errno.
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

// SQLite retains text/blob bindings until rebind or finalization; node:sqlite cannot clear them.
const LARGE_BINDING_SIZE = 64 * 1024;

const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // Named parameters may be callable objects; read data properties only to avoid invoking getters twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    return true;
  }
};

// Inline worker source also runs in bundles and single-executable builds without module files.
const readerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const sqlite = require("node:sqlite");
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: true,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Temporary tables are writable through a read-only open; query_only closes that too, and the
  // authorizer refuses what the open does not: temporary-database writes and query_only itself.
  // Main-database writes still fail as SQLite's read-only open makes them fail. Nothing on a
  // reader can write, so no ending can fail on a constraint. Without an authorizer, query_only.
  next.exec("PRAGMA query_only = ON;");
  if (typeof next.setAuthorizer === "function") {
    const c = sqlite.constants;
    next.setAuthorizer((actionCode, action, _argument, database) =>
      actionCode === c.SQLITE_ATTACH ||
      actionCode === c.SQLITE_DETACH ||
      (actionCode === c.SQLITE_PRAGMA && String(action).toLowerCase() === "query_only") ||
      (database != null &&
        database !== "main" &&
        actionCode !== c.SQLITE_READ &&
        actionCode !== c.SQLITE_SELECT &&
        // Pragmas off the main schema (metadata reads, mostly) cannot make an ending fail.
        actionCode !== c.SQLITE_PRAGMA)
        ? c.SQLITE_DENY
        : c.SQLITE_OK,
    );
  }
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  // Guarded: nothing on this reader can write, so an ending cannot fail and need not be awaited.
  // Tracked: replies say whether a transaction is open, which folding a BEGIN relies on.
  parentPort.postMessage({
    type: "ready",
    guarded: typeof next.setAuthorizer === "function",
    tracked: typeof next.isTransaction === "boolean",
  });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error) });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
const execute = ({ id, sql, params, cached, raw, values, safeIntegers, begin }) => {
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database reader is unavailable");
    if (begin) {
      operation = "begin";
      db.exec("BEGIN");
    }
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(Boolean(safeIntegers));
    if (statement.columns().length > 0) {
      // Arrays clone faster than objects; unless arrays were asked for, the parent restores the
      // objects from the names, read after the statement ran, since SQLite may have reprepared it
      // for a changed schema.
      statement.setReturnArrays(true);
      const rows = statement.all(...params);
      return {
        id,
        columns: values ? undefined : statement.columns().map((column) => column.name),
        rows,
        inTransaction: db.isTransaction,
      };
    }
    const result = statement.run(...params);
    return { id, rows: raw ? result : [], inTransaction: db.isTransaction };
  } catch (error) {
    // The parent keeps its transaction bookkeeping in step with the connection from this flag.
    return {
      id,
      error: {
        operation,
        message: String(error && error.message ? error.message : error),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
      ...(db === undefined ? {} : { inTransaction: db.isTransaction }),
    };
  }
};
parentPort.on("message", (message) => parentPort.postMessage(execute(message)));
`;

interface ReaderRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

type ReaderStartup =
  | { readonly type: "ready"; readonly guarded?: boolean; readonly tracked?: boolean }
  | { readonly type: "unavailable"; readonly message: string };

type ReaderReply =
  | {
      readonly id: number;
      readonly columns?: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<any>;
      readonly inTransaction?: boolean;
    }
  | {
      readonly id: number;
      readonly inTransaction?: boolean;
      readonly error: {
        readonly operation: "open" | "begin" | "prepare" | "execute";
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
      };
    };

const readerFailureMessages = {
  open: "Failed to open database",
  begin: "Failed to begin transaction",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

const objectRows = (columns: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
  rows.map((row) => {
    const object: Record<string, unknown> = {};
    for (let index = 0; index < columns.length; index++) {
      const name = columns[index]!;
      // Assignment would call the inherited setter for a column named __proto__.
      if (name === "__proto__") {
        Object.defineProperty(object, name, {
          value: row[index],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else object[name] = row[index];
    }
    return object;
  });

const withoutComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ");
// Only SQLite's exact plain transaction statements, comments removed, with SQLite's whitespace (not
// JavaScript's \s, which takes a no-break space or vertical tab SQLite rejects). Anything else
// (BEGIN IMMEDIATE, BEGIN2, ROLLBACK TO a savepoint) is an ordinary statement for the worker, which
// answers as SQLite does, and leaves the bookkeeping alone.
const beginsTransaction = (sql: string) =>
  /^[ \t\n\f\r]*BEGIN(?:[ \t\n\f\r]+DEFERRED)?(?:[ \t\n\f\r]+TRANSACTION)?[ \t\n\f\r]*;?[ \t\n\f\r]*$/i.test(
    withoutComments(sql),
  );
const endsReadTransaction = (sql: string) =>
  /^[ \t\n\f\r]*(?:COMMIT|END|ROLLBACK)(?:[ \t\n\f\r]+TRANSACTION)?[ \t\n\f\r]*;?[ \t\n\f\r]*$/i.test(
    withoutComments(sql),
  );
// Read-transaction cleanup succeeds after worker exit because it can no longer change anything.
const cleansUpTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

// WAL readers run concurrently; one worker serialized every read behind the slowest transaction.
const READER_POOL_SIZE = 4;

// Bind transactions to one worker; fail after its exit instead of resuming outside the transaction on a replacement.
const makeReader = Effect.fnUntraced(function* (
  options: SqliteClientConfig,
  pool: { unavailable: boolean },
) {
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<ReaderStartup>;
      }
    | undefined;
  let nextRequestId = 0;

  const start = () => {
    const worker = new NodeWorkerThreads.Worker(readerWorkerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        allowExtension: false,
        prepareCacheSize: 200,
      },
    });
    let announce: (startup: ReaderStartup) => void = () => {};
    const started = new Promise<ReaderStartup>((resolve) => {
      announce = resolve;
    });
    // Whether the worker's authorizer rules out every write, so that an ending cannot fail.
    let guarded = false;
    // Whether replies carry the connection's transaction state; without it no BEGIN is folded.
    let tracked = false;
    let stoppedMessage: string | undefined;
    const pending = new Map<number, (reply: ReaderReply) => void>();
    // A read transaction's BEGIN waits for its first statement and travels with it; once it has
    // left, the reader is in a transaction until its ending statement leaves. A BEGIN or an ending
    // statement that does not fit that state goes to the worker as an ordinary statement and brings
    // back SQLite's error, as it always did, without touching this bookkeeping.
    let pendingBegin = false;
    let inTransaction = false;
    // The id of the newest message that reached the worker: it answers in order and each reply
    // carries the connection's state after that message, so only a reply at or after this id is
    // current (one late to a fiber that gave up on it is not).
    let latestId = 0;
    // A message the worker cannot receive, such as one with an uncloneable binding, fails its
    // own statement; an ending statement with nothing waiting on it is dropped.
    const send = (message: Record<string, unknown>) => {
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage(message);
        return true;
      } catch (cause) {
        // A BEGIN travelling with the message goes with the next statement instead.
        if (message.begin === true) pendingBegin = true;
        const id = message.id as number;
        const resume = pending.get(id);
        if (resume === undefined) return false;
        pending.delete(id);
        if (pending.size === 0) worker.unref();
        resume({
          id,
          error: {
            operation: "execute",
            message: `Statement could not be sent to the reader: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          },
        });
        return false;
      }
    };
    // Every message goes to the worker at once, in order; the worker answers each in that order.
    const post = (message: Record<string, unknown>) =>
      stoppedMessage === undefined && send(message);
    const stop = (message: string) => {
      stoppedMessage = message;
      announce({ type: "unavailable", message });
      if (current?.worker === worker) current = undefined;
      for (const [id, resume] of pending) resume({ id, error: { operation: "execute", message } });
      pending.clear();
    };
    worker.on("message", (reply: ReaderReply | ReaderStartup) => {
      if ("type" in reply) {
        guarded = reply.type === "ready" && reply.guarded === true;
        tracked = reply.type === "ready" && reply.tracked === true;
        announce(reply);
        if (pending.size === 0) worker.unref();
        return;
      }
      const resume = pending.get(reply.id);
      if (resume === undefined) {
        // An unattended ending's reply still tells the connection's state.
        if (reply.inTransaction !== undefined && reply.id >= latestId)
          inTransaction = reply.inTransaction;
        return;
      }
      pending.delete(reply.id);
      // The fiber runs on inside resume and may start cleanup that references the worker again.
      if (pending.size === 0) worker.unref();
      resume(reply);
    });
    worker.on("error", (cause) => stop(`Database reader failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`Database reader exited with code ${code}`));

    const request = (input: ReaderRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        // Only a plain control (no bindings, not raw) is answered here; with bindings SQLite has an
        // error to return, and a raw control has a run() result.
        const control = input.params.length === 0 && !input.raw;
        const begins = control && beginsTransaction(input.sql);
        // Folding is a guess about the connection's state: only when replies report that state,
        // and with nothing outstanding on it (an earlier statement could still open or end a
        // transaction when it runs).
        if (begins && tracked && !pendingBegin && !inTransaction && pending.size === 0) {
          pendingBegin = true;
          return Effect.succeed([]);
        }
        if (
          control &&
          !begins &&
          endsReadTransaction(input.sql) &&
          (pendingBegin || (inTransaction && guarded))
        ) {
          // Ending a read transaction only drops a shared lock: it cannot fail or lose anything, so
          // nothing waits for it, unless statements a fiber gave up on are still running: then the
          // reader stays claimed until the worker has answered them and this ending, as before.
          // (An unguarded reader's ending is an ordinary awaited statement below.)
          pendingBegin = false;
          if (!inTransaction) return Effect.succeed([]);
          inTransaction = false;
          if (stoppedMessage !== undefined) return Effect.succeed([]);
          if (pending.size === 0) {
            const id = nextRequestId++;
            if (post({ id, safeIntegers: false, ...input })) latestId = id;
            return Effect.succeed([]);
          }
          return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
            // The fiber can yield before this runs: a reply landing in that gap may have restored
            // the flag (cleared again here, with the post) or the worker may have stopped (nothing
            // is left to end). Otherwise the ending stays awaited, so SQLite's answer comes back.
            inTransaction = false;
            if (stoppedMessage !== undefined) {
              resume(Effect.succeed([]));
              return;
            }
            // Taken with the post: a sibling that posted in that gap has the older id.
            const id = nextRequestId++;
            // SQLite's answer counts (a control it waited behind may have ended the transaction
            // first); a worker that stopped meanwhile has nothing left to end, as before.
            pending.set(id, (reply) =>
              resume(
                "error" in reply && stoppedMessage === undefined
                  ? Effect.fail(
                      failed(
                        Object.assign(new Error(reply.error.message), {
                          code: reply.error.code,
                          errcode: reply.error.errcode,
                          errstr: reply.error.errstr,
                        }),
                        readerFailureMessages[reply.error.operation],
                        reply.error.operation,
                      ),
                    )
                  : Effect.succeed([]),
              ),
            );
            if (pending.size === 1) worker.ref();
            if (post({ id, safeIntegers: false, ...input })) latestId = id;
            else {
              pending.delete(id);
              if (pending.size === 0) worker.unref();
              resume(Effect.succeed([]));
            }
          });
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        const cleanup = cleansUpTransaction(input.sql);
        return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          // The fiber can yield between building this effect and running it, so the worker's
          // state and the transaction's BEGIN are read here, in the same synchronous step as the
          // post: a sibling posting in that gap, or an interruption in it, must not lose the BEGIN,
          // and a worker that stopped in it must fail the statement rather than never answer.
          if (stoppedMessage !== undefined) {
            resume(
              cleanup
                ? Effect.succeed([])
                : Effect.fail(
                    failed(new Error(stoppedMessage), readerFailureMessages.execute, "execute"),
                  ),
            );
            return;
          }
          const begin = pendingBegin;
          pendingBegin = false;
          const id = nextRequestId++;
          pending.set(id, (reply) => {
            // A control the worker ran itself (raw, bound, duplicate, stray, a savepoint) may have
            // changed the connection's transaction state: the worker's word replaces the guess,
            // unless a newer message has reached the worker since.
            if (reply.inTransaction !== undefined && id >= latestId)
              inTransaction = reply.inTransaction;
            if ("rows" in reply) {
              resume(
                Effect.succeed(
                  reply.columns !== undefined && !input.values
                    ? objectRows(reply.columns, reply.rows)
                    : reply.rows,
                ),
              );
              return;
            }
            if (cleanup && stoppedMessage !== undefined) {
              resume(Effect.succeed([]));
              return;
            }
            const { operation, message, ...codes } = reply.error;
            resume(
              Effect.fail(
                failed(
                  Object.assign(new Error(message), codes),
                  readerFailureMessages[operation],
                  operation,
                ),
              ),
            );
          });
          if (pending.size === 1) worker.ref();
          const cached = input.cached && !hasLargeBinding(input.params);
          if (post({ id, safeIntegers, ...input, cached, ...(begin ? { begin } : {}) }))
            latestId = id;
        });
      });

    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = request({ sql, params, cached: true, values: false, raw: false });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return request({ sql, params, cached: true, values: false, raw: true });
      },
      executeValues(sql, params) {
        return request({ sql, params, cached: true, values: true, raw: false });
      },
      executeValuesUnprepared(sql, params) {
        return request({ sql, params: params ?? [], cached: false, values: true, raw: false });
      },
      executeUnprepared(sql, params, rowTransform) {
        // Read snapshots need deferred BEGIN; readonly connections reject IMMEDIATE and EXCLUSIVE.
        const statement = /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
        const effect = request({
          sql: statement,
          params: params ?? [],
          cached: false,
          values: false,
          raw: false,
        });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    current = { worker, connection, started };
    return current;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await current?.worker.terminate();
    }),
  );

  const startupTimeout = Duration.seconds(10);

  const turnOff = (reader: typeof current, reason: string) =>
    Effect.suspend(() => {
      if (reader !== undefined) {
        if (current === reader) current = undefined;
        void reader.worker.terminate();
      }
      if (pool.unavailable) return Effect.undefined;
      pool.unavailable = true;
      return Effect.logWarning("SQLite reader worker unavailable; reads use the main connection", {
        reason,
      }).pipe(Effect.as(undefined));
    });

  return Effect.suspend((): Effect.Effect<Connection | undefined> => {
    if (pool.unavailable) return Effect.undefined;
    let reader: NonNullable<typeof current>;
    try {
      reader = current ?? start();
    } catch (cause) {
      return turnOff(undefined, String(cause));
    }
    return Effect.flatMap(
      Effect.withFiber((fiber) => {
        const restore = Context.get(fiber.context, ReadOnly) ?? identity;
        return restore(
          Effect.timeoutOption(
            Effect.promise(() => reader.started),
            startupTimeout,
          ),
        );
      }),
      (startup): Effect.Effect<Connection | undefined> =>
        // A late ready event must not hand out a worker retired by another acquire timeout.
        pool.unavailable || current !== reader
          ? Effect.undefined
          : Option.isSome(startup) && startup.value.type === "ready"
            ? Effect.succeed(reader.connection)
            : turnOff(
                reader,
                Option.isSome(startup) && startup.value.type === "unavailable"
                  ? startup.value.message
                  : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
              ),
    );
  });
});

const CHECKPOINT_FRAMES = 1000;
const CHECKPOINT_IDLE_MS = 100;
const CHECKPOINT_BACKPRESSURE_FRAMES = 32_768;

const readSafeSqliteInteger = (value: unknown) => {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
};

// Evaluated source also works in bundles and single-executable builds.
const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");
let db;
let frames;
let checkpoint;
let truncate;
let journalSizeLimit = -1;
let generation = 0;
let nextTruncateId = 0;
let pendingTruncate;
let pendingBarriers = 0;
let idle;
const initialize = () => {
  if (db !== undefined) return;
  // The writer switches to WAL after constructing the client.
  db = new DatabaseSync(workerData.filename);
  db.exec("PRAGMA busy_timeout = 5000;");
  const mode = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  // macOS requires F_FULLFSYNC to flush the drive cache.
  db.exec("PRAGMA checkpoint_fullfsync = ON;");
  frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
  checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  truncate = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
};
const atCeiling = (state) => state.log >= workerData.backpressureFrames;
const exceedsSizeLimit = () =>
  journalSizeLimit >= 0 && statSync(workerData.filename + "-wal").size > journalSizeLimit;
// Retry a WAL past its limits even with admission open, so it resets once a pinning reader closes.
const schedule = (state, retry) => {
  if (retry || state.log - state.checkpointed >= workerData.frames) {
    idle = setTimeout(() => check(undefined, undefined, true), workerData.idleMs);
  }
};
const check = (id, nextJournalSizeLimit, force, nextGeneration = generation) => {
  initialize();
  if (Number.isSafeInteger(nextGeneration)) generation = Math.max(generation, nextGeneration);
  if (Number.isSafeInteger(nextJournalSizeLimit)) journalSizeLimit = nextJournalSizeLimit;
  let state = frames.get();
  const oversized = exceedsSizeLimit();
  let pinned = false;
  if (force || state.log - state.checkpointed >= workerData.frames || oversized) {
    const result = checkpoint.get();
    // A reader's snapshot stopped the backfill; holding writes cannot let it catch up.
    pinned = result.checkpointed < result.log;
    state = frames.get();
  }
  if (state.checkpointed === state.log && (atCeiling(state) || oversized)) {
    pendingTruncate = { truncateId: ++nextTruncateId, checkId: id, generation, state };
    parentPort.postMessage({
      type: "truncate-request",
      truncateId: pendingTruncate.truncateId,
      checkId: id,
      generation,
      ...state,
    });
    return;
  }
  const blocked = !pinned && (atCeiling(state) || oversized) && state.checkpointed < state.log;
  parentPort.postMessage({ type: "checkpoint", id, generation, ...state, blocked });
  schedule(state, atCeiling(state) || oversized);
};
const finishTruncate = (truncateId) => {
  if (pendingTruncate === undefined || pendingTruncate.truncateId !== truncateId) return;
  const pending = pendingTruncate;
  parentPort.postMessage({ type: "truncate-start", truncateId });
  // Admission is paused here; a pinned reader must not make truncation wait.
  db.exec("PRAGMA busy_timeout = 0;");
  try {
    truncate.get();
  } finally {
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  const state = frames.get();
  pendingTruncate = undefined;
  parentPort.postMessage({
    type: "checkpoint",
    id: pending.checkId,
    generation: pending.generation,
    truncateId,
    ...state,
    // With writes held, only a reader can stop the reset, and holding them longer would not
    // release it.
    blocked: false,
  });
  while (pendingBarriers > 0) {
    pendingBarriers--;
    parentPort.postMessage("barrier");
  }
  schedule(state, atCeiling(state) || exceedsSizeLimit());
};
parentPort.on("message", (request) => {
  clearTimeout(idle);
  if (request && request.type === "truncate") {
    finishTruncate(request.truncateId);
    return;
  }
  const isBarrier = request === "barrier";
  if (pendingTruncate !== undefined) {
    if (isBarrier) pendingBarriers++;
    else if (request && request.type === "check") {
      // Retire the request without labeling the pending snapshot with a newer generation.
      parentPort.postMessage({
        type: "checkpoint",
        id: request.id,
        generation: pendingTruncate.generation,
        ...pendingTruncate.state,
        blocked: true,
      });
    }
    return;
  }
  const input = request && typeof request === "object" ? request : {};
  check(input.id, input.journalSizeLimit, input.force, input.generation);
  if (isBarrier) {
    if (pendingTruncate !== undefined) pendingBarriers++;
    else parentPort.postMessage("barrier");
  }
});
`;

const startCheckpointWorker = Effect.fnUntraced(function* (
  filename: string,
  writer: NodeSqlite.DatabaseSync,
) {
  const warn = (reason: string) =>
    Effect.logWarning(
      "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
      { reason },
    );
  if (typeof writer.isTransaction !== "boolean" || typeof writer.setAuthorizer !== "function") {
    yield* warn("Node SQLite lacks transaction-state or statement-authorizer support");
    return undefined;
  }
  // These are the writer's first statements, before callers set their own wait.
  writer.exec("PRAGMA busy_timeout = 5000;");
  const version = String(writer.prepare("SELECT sqlite_version() AS version").get()?.version);
  const [major = 0, minor = 0] = version.split(".").map(Number);
  // Older SQLite treats NOOP as PASSIVE, which would checkpoint on the writer.
  if (major < 3 || (major === 3 && minor < 51)) {
    yield* warn(`SQLite ${version} has no NOOP checkpoint`);
    return undefined;
  }
  const frames = writer.prepare("PRAGMA wal_checkpoint(NOOP)");
  const sizeLimit = writer.prepare("PRAGMA journal_size_limit");
  const started = Result.try(
    () =>
      new NodeWorkerThreads.Worker(checkpointWorkerSource, {
        eval: true,
        workerData: {
          filename,
          frames: CHECKPOINT_FRAMES,
          backpressureFrames: CHECKPOINT_BACKPRESSURE_FRAMES,
          idleMs: CHECKPOINT_IDLE_MS,
        },
      }),
  );
  if (Result.isFailure(started)) {
    yield* warn(String(started.failure));
    return undefined;
  }
  const worker = started.success;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let stopped = false;
  let generation = 0;
  let nextId = 0;
  let inFlight: number | undefined;
  let checkAgain = false;
  let blocked = false;
  let log = 0;
  let checkpointed = 0;
  let unknown = false;
  let truncate: { id: number; acknowledged: boolean } | undefined;
  type Waiter = { resume: () => void; cancelled: boolean };
  const waiters: Array<Waiter> = [];
  let elected: Waiter | undefined;
  const gated = () =>
    !stopped && !writer.isTransaction && (unknown || blocked || truncate !== undefined);
  const wake = () => {
    if (!gated() && elected === undefined) {
      elected = waiters.shift();
      elected?.resume();
    }
    if (waiters.length === 0 && elected === undefined) worker.unref();
  };
  const release = (waiter: Waiter) => {
    waiter.cancelled = true;
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    if (elected === waiter) elected = undefined;
    wake();
  };
  const handBack = (reason: string) => {
    if (stopped) return;
    stopped = true;
    truncate = undefined;
    try {
      writer.exec(`PRAGMA wal_autocheckpoint = ${CHECKPOINT_FRAMES};`);
    } catch {}
    wake();
    runFork(warn(reason));
  };
  const send = (message: unknown) => {
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage(message);
    } catch (cause) {
      handBack(String(cause));
    }
  };
  const acknowledge = () => {
    if (truncate === undefined || truncate.acknowledged || stopped || writer.isTransaction) return;
    truncate.acknowledged = true;
    send({ type: "truncate", truncateId: truncate.id });
  };
  const observe = () => {
    try {
      const state = frames.get();
      const nextLog = readSafeSqliteInteger(state?.log);
      const nextCheckpointed = readSafeSqliteInteger(state?.checkpointed);
      if (nextLog === undefined || nextCheckpointed === undefined)
        throw new Error("Invalid WAL frame counts");
      log = nextLog;
      checkpointed = nextCheckpointed;
      unknown = false;
      // Past the ceiling, hold writes until the worker judges this WAL; a reader can pin it there.
      if (log >= CHECKPOINT_BACKPRESSURE_FRAMES) blocked = true;
    } catch {
      unknown = true;
    }
  };
  const request = (force = false) => {
    if (stopped || writer.isTransaction) return;
    if (truncate !== undefined) {
      acknowledge();
      return;
    }
    if (inFlight !== undefined) {
      checkAgain = true;
      return;
    }
    if (!force && !gated() && log - checkpointed < CHECKPOINT_FRAMES) return;
    inFlight = ++nextId;
    try {
      send({
        type: "check",
        id: inFlight,
        generation,
        journalSizeLimit: readSafeSqliteInteger(sizeLimit.get()?.journal_size_limit),
        force: force || gated(),
      });
    } catch (cause) {
      handBack(String(cause));
    }
  };
  const check = () => {
    if (stopped || writer.isTransaction) return;
    generation++;
    observe();
    request();
    wake();
  };
  worker.on("error", (cause) => handBack(cause.message));
  worker.on("exit", (code) => handBack(`exited with code ${code}`));
  worker.on("message", (message: unknown) => {
    if (stopped || typeof message !== "object" || message === null || !("type" in message)) return;
    if (
      message.type === "truncate-request" &&
      "truncateId" in message &&
      typeof message.truncateId === "number"
    ) {
      truncate = { id: message.truncateId, acknowledged: false };
      blocked = true;
      acknowledge();
      return;
    }
    if (message.type !== "checkpoint") return;
    const completedTruncate =
      truncate !== undefined && "truncateId" in message && message.truncateId === truncate.id;
    if (completedTruncate) truncate = undefined;
    // An acknowledged truncate excludes new writer mutations, so its result is current.
    if (
      (completedTruncate || ("generation" in message && message.generation === generation)) &&
      "log" in message &&
      typeof message.log === "number" &&
      "checkpointed" in message &&
      typeof message.checkpointed === "number" &&
      "blocked" in message &&
      typeof message.blocked === "boolean"
    ) {
      log = message.log;
      checkpointed = message.checkpointed;
      blocked = message.blocked;
      unknown = false;
    }
    // Even a stale snapshot must retire its request so a newer check can run.
    if ("id" in message && message.id === inFlight) inFlight = undefined;
    if (checkAgain && inFlight === undefined) {
      checkAgain = false;
      request(true);
    }
    wake();
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      stopped = true;
      truncate = undefined;
      wake();
      return worker.terminate();
    }),
  );
  writer.exec("PRAGMA wal_autocheckpoint = 0;");
  observe();
  worker.unref();

  const runWithAdmission = <A, E>(
    execute: () => Exit.Exit<A, E>,
    admitted?: Waiter,
  ): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      if (!gated()) {
        // Release the election after executing; its successor must see the new WAL state.
        try {
          return execute();
        } finally {
          if (admitted !== undefined) release(admitted);
        }
      }
      if (admitted !== undefined) release(admitted);
      const waiter: Waiter = { resume: () => {}, cancelled: false };
      const wait = Effect.uninterruptibleMask((restore) =>
        Effect.withFiber((fiber) =>
          (fiber.getRef(TransactionAcquire)?.restore ?? restore)(
            Effect.callback<void>(function (this: Scheduler.Scheduler, resume) {
              const dispatcher = this.makeDispatcher();
              waiter.resume = () => {
                dispatcher.scheduleTask(() => {
                  if (!waiter.cancelled) resume(Effect.void);
                }, 0);
              };
              waiters.push(waiter);
              worker.ref();
              request(true);
              wake();
              return Effect.sync(() => release(waiter));
            }),
          ),
        ),
      );
      return wait.pipe(
        Effect.flatMap(() => runWithAdmission(execute, waiter)),
        Effect.onInterrupt(() => Effect.sync(() => release(waiter))),
      );
    });
  return { check, runWithAdmission };
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite();
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );
    // Started after the close finalizer, so the worker stops before the writer closes.
    const checkpoint =
      options.checkpointWorker && isFileDatabase
        ? yield* startCheckpointWorker(options.filename, db)
        : undefined;

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    interface CheckpointClassification {
      backpressure: boolean;
      check: boolean;
    }
    const checkpointClassifications = new WeakMap<
      NodeSqlite.StatementSync,
      CheckpointClassification
    >();
    const mutatingPragmasWithValues = new Set([
      "application_id",
      "auto_vacuum",
      "journal_mode",
      "schema_version",
      "user_version",
    ]);
    const mutatesPragma = (name: string | null, value: string | null) => {
      const pragma = name?.toLowerCase();
      if (pragma === undefined) return false;
      if (pragma === "incremental_vacuum" || pragma === "optimize") return true;
      if (pragma === "wal_checkpoint") return value?.toLowerCase() !== "noop";
      return value !== null && mutatingPragmasWithValues.has(pragma);
    };
    let activeClassification: CheckpointClassification | undefined;
    const withClassification = <A>(
      classification: CheckpointClassification | undefined,
      f: () => A,
    ): A => {
      if (classification === undefined) return f();
      const previous = activeClassification;
      activeClassification = classification;
      try {
        return f();
      } finally {
        activeClassification = previous;
      }
    };
    if (checkpoint !== undefined) {
      // SQLite may reprepare an expired statement while it executes. Keep this
      // callback installed and collect only around that statement's prepare/run.
      db.setAuthorizer((actionCode, action, argument) => {
        const classification = activeClassification;
        if (classification === undefined) return NodeSqlite.constants.SQLITE_OK;
        const constants = NodeSqlite.constants;
        if (actionCode === constants.SQLITE_TRANSACTION) {
          classification.backpressure ||= action === "BEGIN";
          classification.check ||= action === "COMMIT" || action === "ROLLBACK";
        } else if (actionCode === constants.SQLITE_SAVEPOINT) {
          classification.backpressure ||= action === "BEGIN";
          classification.check = true;
        } else if (actionCode === constants.SQLITE_PRAGMA && mutatesPragma(action, argument)) {
          classification.backpressure = true;
          classification.check = true;
        } else if (
          actionCode !== constants.SQLITE_READ &&
          actionCode !== constants.SQLITE_SELECT &&
          actionCode !== constants.SQLITE_FUNCTION &&
          actionCode !== constants.SQLITE_RECURSIVE &&
          actionCode !== constants.SQLITE_PRAGMA
        ) {
          classification.backpressure = true;
          classification.check = true;
        }
        return constants.SQLITE_OK;
      });
    }
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => {
          const classification = { backpressure: false, check: false };
          const statement = withClassification(classification, () => db.prepare(sql));
          if (checkpoint !== undefined) checkpointClassifications.set(statement, classification);
          return statement;
        },
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.zero),
    });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "raw" | "values" = "rows",
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const classification = checkpointClassifications.get(statement);
        const execute = () => {
          let arrays = false;
          let result: Exit.Exit<ReadonlyArray<unknown>, SqlError>;
          try {
            const value = withClassification(classification, () => {
              statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
              if (hasRows(statement)) {
                arrays = mode === "values";
                if (arrays) statement.setReturnArrays(true);
                return statement.all(...(params as any));
              }
              const result = statement.run(...(params as any));
              return mode === "raw" ? (result as unknown as ReadonlyArray<unknown>) : [];
            });
            result = Exit.succeed(value);
          } catch (cause) {
            result = Exit.fail(
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
            );
          } finally {
            // OR FAIL may have committed earlier rows even when execution throws.
            if (classification?.check) checkpoint?.check();
          }
          if (arrays) {
            try {
              statement.setReturnArrays(false);
            } catch (cause) {
              return Exit.die(
                new SqlError({
                  reason: classifyError(
                    cause,
                    "Failed to reset statement result mode",
                    "resetResultMode",
                  ),
                }),
              );
            }
          }
          return result;
        };
        return checkpoint !== undefined && classification?.backpressure
          ? checkpoint.runWithAdmission(execute)
          : execute();
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, raw ? "raw" : "rows"),
      );
    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, "values"),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatement(statement, params ?? [], "values"),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [])),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;
  // A reader that cannot start turns off the whole pool, so routing never picks a dead slot.
  const readerPool = { unavailable: false };
  const readers =
    options.readerWorker && isFileDatabase
      ? yield* Effect.forEach(Array.from({ length: READER_POOL_SIZE }), () =>
          Effect.map(
            Effect.all([makeReader(options, readerPool), Semaphore.make(1)]),
            ([acquire, lock]) => ({
              acquire,
              lock,
              claims: 0,
            }),
          ),
        )
      : [];

  const writer = { name: "writer" as const, lock: semaphore, connection };
  let activeWriter: ConnectionOwner | undefined;
  // Callers must run route uninterruptibly and pass `claimed` a finalizer that runs `release` once.
  const route = (claimed: (release: Effect.Effect<void>) => Effect.Effect<void>) =>
    Effect.withFiber((fiber) => {
      if (readers.length === 0 || readerPool.unavailable || !Context.get(fiber.context, ReadOnly)) {
        return Effect.succeed(writer);
      }
      // Least claimed wins and ties go to the lowest slot, so idle slots never start a worker.
      let slot = readers[0]!;
      for (const candidate of readers) if (candidate.claims < slot.claims) slot = candidate;
      slot.claims++;
      const reader = slot;
      return Effect.andThen(
        claimed(
          Effect.sync(() => {
            reader.claims--;
          }),
        ),
        Effect.map(reader.acquire, (readerConnection) =>
          readerConnection === undefined
            ? writer
            : { name: "reader" as const, lock: reader.lock, connection: readerConnection },
        ),
      );
    });

  const acquired = (
    target: { readonly name: Acquired["connection"] },
    clock: Clock.Clock,
    start: bigint,
  ): Acquired => ({
    connection: target.name,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const writerBorrowBatchSize = 16;
  let writerBorrowsSinceYield = 0;
  const borrower: Borrower = (use) =>
    Effect.uninterruptibleMask((restore) => {
      let release: Effect.Effect<void> = Effect.void;
      const claimed = (next: Effect.Effect<void>) =>
        Effect.sync(() => {
          release = next;
        });
      return Effect.flatMap(route(claimed), (target) => restore(borrowTarget(target, use))).pipe(
        Effect.ensuring(Effect.suspend(() => release)),
      );
    });
  const borrowTarget = <A, E, R>(
    target: {
      readonly name: Acquired["connection"];
      readonly lock: Semaphore.Semaphore;
      readonly connection: Connection;
    },
    use: (connection: Connection) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.withFiber((fiber) => {
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const ownerAtWaitStart = target.name === "writer" ? activeWriter : undefined;
      const owner = target.name === "writer" ? connectionOwner(fiber) : undefined;
      const useConnection = Effect.suspend(() => {
        if (target.name === "writer") activeWriter = owner;
        if (
          fiber.getRef(References.TracerEnabled) &&
          fiber.getRef(Statement.SpanPropagationEnabled)
        ) {
          annotateAcquired(fiber, acquired(target, clock, start), ownerAtWaitStart);
        }
        return use(target.connection);
      });
      const useOwnedConnection =
        target.name === "writer"
          ? Effect.onExit(useConnection, () =>
              Effect.sync(() => {
                if (activeWriter === owner) activeWriter = undefined;
              }),
            )
          : useConnection;
      if (!options.checkpointWorker || target.name !== "writer") {
        return target.lock.withPermits(1)(useOwnedConnection);
      }
      const writerUse = Effect.onExit(useOwnedConnection, (exit) =>
        Effect.sync(() => {
          writerBorrowsSinceYield = Exit.hasInterrupts(exit)
            ? 0
            : Math.min(writerBorrowsSinceYield + 1, writerBorrowBatchSize);
        }),
      );
      return Effect.flatMap(target.lock.withPermitsIfAvailable(1)(writerUse), (result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : target.lock.withPermits(1)(
              Effect.andThen(
                // Failed SQL also consumes the batch; cancellation hands off immediately.
                Effect.suspend(() => {
                  if (writerBorrowsSinceYield < writerBorrowBatchSize) return Effect.void;
                  writerBorrowsSinceYield = 0;
                  return Effect.callback<void>((resume) => {
                    const immediate = setImmediate(() => resume(Effect.void));
                    return Effect.sync(() => clearImmediate(immediate));
                  });
                }),
                writerUse,
              ),
            ),
      );
    });
  const claimedUntilScopeCloses = (release: Effect.Effect<void>) =>
    Effect.withFiber((fiber) =>
      Scope.addFinalizer(Context.getUnsafe(fiber.context, Scope.Scope), release),
    );
  const transactionAcquirer = Effect.uninterruptible(route(claimedUntilScopeCloses)).pipe(
    Effect.flatMap((target) =>
      Effect.uninterruptibleMask((restore) => {
        const fiber = Fiber.getCurrent()!;
        const scope = Context.getUnsafe(fiber.context, Scope.Scope);
        const clock = fiber.getRef(Clock.Clock);
        const start = clock.monotonicTimeNanosUnsafe();
        const pending = fiber.getRef(TransactionAcquire);
        const ownerAtWaitStart = target.name === "writer" ? activeWriter : undefined;
        const owner = target.name === "writer" ? connectionOwner(fiber) : undefined;
        const acquire = Effect.tap((pending?.restore ?? restore)(target.lock.take(1)), () => {
          if (target.name === "writer") activeWriter = owner;
          if (pending !== undefined) {
            pending.acquired = acquired(target, clock, start);
            pending.ownerAtWaitStart = ownerAtWaitStart;
          }
          return Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              if (target.name === "writer" && activeWriter === owner) activeWriter = undefined;
            }).pipe(Effect.andThen(target.lock.release(1))),
          );
        });
        return Effect.as(
          // A scheduler yield after taking the permit must not precede its release finalizer.
          Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
          target.connection,
        );
      }),
    ),
  );

  const client = yield* Client.make({
    driver: "node:sqlite",
    acquirer: transactionAcquirer,
    borrower,
    compiler,
    transactionAcquirer,
    // BEGIN IMMEDIATE avoids read-then-write SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot resolve.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) => {
        // SqlClient masks setup; acquisition must preserve the caller's interruptibility.
        const pending: {
          acquired?: Acquired;
          ownerAtWaitStart: ConnectionOwner | undefined;
          restore: typeof Effect.interruptible | undefined;
        } = {
          ownerAtWaitStart: undefined,
          restore,
        };
        const body = Effect.withFiber<A, E, R>((fiber) => {
          annotateAcquired(fiber, pending.acquired, pending.ownerAtWaitStart);
          pending.restore = undefined;
          return effect;
        });
        return restore(
          withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending)),
        );
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));

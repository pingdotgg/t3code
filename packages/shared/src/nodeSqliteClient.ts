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
  /** Runs the writer and WAL checkpoints off the event loop. Ignored for in-memory databases. */
  readonly writerWorker?: boolean | undefined;
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
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const describe = (error) => ({
  message: String(error && error.message ? error.message : error),
  code: error && error.code,
  errcode: error && error.errcode,
  errstr: error && error.errstr,
});
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: workerData.readOnly,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Reads the header, so a file that is not a database fails here rather than on first use.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  if (workerData.requireWal && mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", ...describe(error) });
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
parentPort.on("message", (request) => {
  if (request.type === "close") {
    // Closing lets SQLite checkpoint and remove the WAL, which terminating would skip.
    try {
      if (db !== undefined) db.close();
    } catch {}
    parentPort.close();
    return;
  }
  const { id, sql, params, cached, values, raw, safeIntegers } = request;
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database connection is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      parentPort.postMessage({ id, rows: statement.all(...params) });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [] });
    }
  } catch (error) {
    parentPort.postMessage({ id, error: { operation, ...describe(error) } });
  }
});
`;

interface WorkerRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

interface WorkerFailure {
  readonly message: string;
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
}

type WorkerStartup =
  | { readonly type: "ready" }
  | ({ readonly type: "unavailable" } & WorkerFailure);

type WorkerReply =
  | { readonly id: number; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly error: WorkerFailure & { readonly operation: "open" | "prepare" | "execute" };
    };

const workerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

const failedWith = (
  { message, code, errcode, errstr }: WorkerFailure,
  operation: keyof typeof workerFailureMessages,
) =>
  failed(
    Object.assign(new Error(message), { code, errcode, errstr }),
    workerFailureMessages[operation],
    operation,
  );

// Read-transaction cleanup succeeds after worker exit because it can no longer change anything.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

// WAL readers run concurrently; one worker serialized every read behind the slowest transaction.
const READER_POOL_SIZE = 4;
const READER_STARTUP_TIMEOUT = Duration.seconds(10);

// Bind transactions to one worker; fail after its exit instead of resuming outside the transaction on a replacement.
const makeWorkerConnection = Effect.fnUntraced(function* (options: {
  readonly filename: string;
  readonly role: "reader" | "writer";
  readonly readOnly: boolean;
  readonly onReply?: () => void;
}) {
  const label = options.role === "reader" ? "Database reader" : "Database writer";
  const readOnly = options.readOnly;
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<WorkerStartup>;
      }
    | undefined;
  let nextRequestId = 0;
  // A replacement writer would lose the pragmas callers set on it, such as foreign_keys.
  let writerStopped: string | undefined;

  const start = () => {
    const worker = new NodeWorkerThreads.Worker(workerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        readOnly,
        requireWal: options.role === "reader",
        allowExtension: false,
        prepareCacheSize: 200,
      },
    });
    let announce: (startup: WorkerStartup) => void = () => {};
    const started = new Promise<WorkerStartup>((resolve) => {
      announce = resolve;
    });
    let stoppedMessage: string | undefined;
    const pending = new Map<
      number,
      { readonly endsTransaction: boolean; readonly resume: (reply: WorkerReply) => void }
    >();
    const stop = (message: string) => {
      stoppedMessage = message;
      if (options.role === "writer") writerStopped = message;
      announce({ type: "unavailable", message });
      if (current?.worker === worker) current = undefined;
      for (const [id, request] of pending) {
        request.resume(
          request.endsTransaction
            ? { id, rows: [] }
            : { id, error: { operation: "execute", message } },
        );
      }
      pending.clear();
    };
    worker.on("message", (reply: WorkerReply | WorkerStartup) => {
      if ("type" in reply) {
        announce(reply);
        if (pending.size === 0) worker.unref();
        return;
      }
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      options.onReply?.();
      request.resume(reply);
    });
    worker.on("error", (cause) => stop(`${label} failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`${label} exited with code ${code}`));

    const request = (input: WorkerRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        // A COMMIT that never reached a writer must fail; only its ROLLBACK is moot.
        const endsTransaction = readOnly
          ? endsReadTransaction(input.sql)
          : /^\s*ROLLBACK\b/i.test(input.sql);
        if (stoppedMessage !== undefined) {
          return endsTransaction
            ? Effect.succeed([])
            : Effect.fail(failedWith({ message: stoppedMessage }, "execute"));
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        const reply = Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          const id = nextRequestId++;
          pending.set(id, {
            endsTransaction,
            resume: (reply) =>
              resume(
                "rows" in reply
                  ? Effect.succeed(reply.rows)
                  : Effect.fail(failedWith(reply.error, reply.error.operation)),
              ),
          });
          if (pending.size === 1) worker.ref();
          const cached = input.cached && !hasLargeBinding(input.params);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, cached });
        });
        // A posted write runs to the end, as it did on the event loop; the caller and its lock
        // must not move on while the worker is still applying it. Reads stay cancellable.
        return options.role === "writer" ? Effect.uninterruptible(reply) : reply;
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
        const statement = readOnly && /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
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
      const open = current;
      if (open === undefined) return;
      if (options.role === "writer") {
        await new Promise<void>((resolve) => {
          open.worker.once("exit", () => resolve());
          open.worker.ref();
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          open.worker.postMessage({ type: "close" });
        });
      }
      await open.worker.terminate();
    }),
  );

  const retire = (worker: NodeWorkerThreads.Worker) => {
    if (current?.worker === worker) current = undefined;
    void worker.terminate();
  };

  return Effect.suspend((): Effect.Effect<Connection, SqlError> => {
    if (current === undefined && writerStopped !== undefined) {
      return Effect.fail(failedWith({ message: writerStopped }, "execute"));
    }
    let entry: NonNullable<typeof current>;
    try {
      entry = current ?? start();
    } catch (cause) {
      return Effect.fail(failed(cause, workerFailureMessages.open, "open"));
    }
    const started = Effect.promise(() => entry.started);
    return Effect.flatMap(
      Effect.withFiber((fiber) => {
        const restore = Context.get(fiber.context, ReadOnly) ?? identity;
        // Readers fall back to the writer; the writer has no fallback, so a slow disk only delays it.
        return restore(
          options.role === "reader"
            ? Effect.timeoutOption(started, READER_STARTUP_TIMEOUT)
            : Effect.asSome(started),
        );
      }),
      (startup): Effect.Effect<Connection, SqlError> => {
        const outcome = Option.getOrUndefined(startup);
        if (outcome?.type === "ready") {
          // A late ready event must not hand out a worker retired by another acquire timeout.
          return current === entry
            ? Effect.succeed(entry.connection)
            : Effect.fail(failedWith({ message: `${label} stopped while starting` }, "open"));
        }
        retire(entry.worker);
        return Effect.fail(
          failedWith(
            outcome ?? {
              message: `${label} did not open the database within ${Duration.toMillis(READER_STARTUP_TIMEOUT)} ms`,
            },
            "open",
          ),
        );
      },
    );
  });
});

// A reader that cannot start turns off the whole pool, so routing never picks a dead slot.
const makeReader = Effect.fnUntraced(function* (filename: string, pool: { unavailable: boolean }) {
  const acquire = yield* makeWorkerConnection({ filename, role: "reader", readOnly: true });
  return Effect.suspend((): Effect.Effect<Connection | undefined> =>
    pool.unavailable
      ? Effect.undefined
      : acquire.pipe(
          Effect.map((connection) => (pool.unavailable ? undefined : connection)),
          Effect.catch((error) => {
            if (pool.unavailable) return Effect.undefined;
            pool.unavailable = true;
            const cause = error.reason.cause;
            return Effect.logWarning("SQLite reader worker unavailable; reads use the writer", {
              reason: cause instanceof Error ? cause.message : error.message,
            }).pipe(Effect.as(undefined));
          }),
        ),
  );
});

// A checkpoint copies WAL pages into the database and syncs it. On the writer's thread every
// write would wait for that sync, so a second connection checkpoints beside the writes.
const CHECKPOINT_FRAMES = 1000;
const CHECKPOINT_IDLE_MS = 100;
// If checkpoints fall behind constant writes, the writer checkpoints itself, delaying writes only.
const WRITER_BACKSTOP_FRAMES = 10_000;

const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
let frames;
let passive;
let idle;
const check = (force) => {
  if (db === undefined) {
    db = new DatabaseSync(workerData.filename);
    db.exec("PRAGMA busy_timeout = 5000;");
    // macOS requires F_FULLFSYNC to flush the drive cache.
    db.exec("PRAGMA checkpoint_fullfsync = ON;");
    frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
    passive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  }
  const before = frames.get();
  let state = before;
  if (state.log - state.checkpointed >= workerData.frames || (force && state.log > state.checkpointed)) {
    passive.get();
    state = frames.get();
  }
  // The WAL restarts only once every frame is checkpointed, so catch up when writes pause.
  // A reader pinning the WAL stops progress; the next write retries instead of a timer loop.
  const progressed = !force || state.checkpointed > before.checkpointed;
  if (state.log > state.checkpointed && progressed) {
    idle = setTimeout(() => run(true), workerData.idleMs);
  }
  parentPort.postMessage({ type: "checked", log: state.log, checkpointed: state.checkpointed });
};
const run = (force) => {
  clearTimeout(idle);
  try {
    check(force);
  } catch (error) {
    parentPort.postMessage({ type: "failed", message: String(error && error.message ? error.message : error) });
  }
};
parentPort.on("message", () => run(false));
`;

const sqliteVersion = () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    return String(db.prepare("SELECT sqlite_version() AS version").get()?.version);
  } finally {
    db.close();
  }
};

// Returns the writer's per-statement notification, or undefined when the writer checkpoints alone.
const startCheckpointWorker = Effect.fnUntraced(function* (filename: string) {
  const warn = (reason: string) =>
    Effect.logWarning("SQLite checkpoint worker unavailable; the writer checkpoints its own WAL", {
      reason,
    });
  const version = sqliteVersion();
  const [major = 0, minor = 0] = version.split(".").map(Number);
  // Older SQLite treats NOOP as PASSIVE, so counting frames would checkpoint on every write.
  if (major < 3 || (major === 3 && minor < 51)) {
    yield* warn(`SQLite ${version} has no NOOP checkpoint`);
    return undefined;
  }
  const started = Result.try(
    () =>
      new NodeWorkerThreads.Worker(checkpointWorkerSource, {
        eval: true,
        workerData: { filename, frames: CHECKPOINT_FRAMES, idleMs: CHECKPOINT_IDLE_MS },
      }),
  );
  if (Result.isFailure(started)) {
    yield* warn(String(started.failure));
    return undefined;
  }
  const worker = started.success;
  worker.unref();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let stopped = false;
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = true;
    void worker.terminate();
    runFork(warn(reason));
  };
  worker.on("message", (message: { readonly type?: unknown; readonly message?: unknown }) => {
    if (message?.type === "failed") stop(String(message.message));
  });
  worker.on("error", (cause) => stop(cause.message));
  worker.on("exit", (code) => stop(`exited with code ${code}`));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      stopped = true;
      return worker.terminate();
    }),
  );
  let scheduled = false;
  return () => {
    if (stopped || scheduled) return;
    scheduled = true;
    // One check per event-loop turn is enough, however many statements finished in it.
    setImmediate(() => {
      scheduled = false;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      if (!stopped) worker.postMessage(0);
    });
  };
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
    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
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
        try: () => db.prepare(sql),
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
        let arrays = false;
        let result: Exit.Exit<ReadonlyArray<unknown>, SqlError>;
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          if (hasRows(statement)) {
            arrays = mode === "values";
            if (arrays) statement.setReturnArrays(true);
            result = Exit.succeed(statement.all(...(params as any)));
          } else {
            const value = statement.run(...(params as any));
            result = Exit.succeed(
              mode === "raw" ? (value as unknown as ReadonlyArray<unknown>) : [],
            );
          }
        } catch (cause) {
          result = Exit.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to execute statement", "execute"),
            }),
          );
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
  const writerWorker = options.writerWorker === true && isFileDatabase;
  let checkpointAfterWrite: (() => void) | undefined;
  const writerConnection: Effect.Effect<Connection, SqlError> = writerWorker
    ? yield* makeWorkerConnection({
        filename: options.filename,
        role: "writer",
        readOnly: options.readonly ?? false,
        onReply: () => checkpointAfterWrite?.(),
      })
    : Effect.succeed(yield* makeConnection);
  // Opening now fails the layer for a file that is not a database, not its first query.
  const opened = yield* writerConnection;
  // Started after the writer, so it stops first and the writer's close can checkpoint.
  if (writerWorker && options.readonly !== true) {
    checkpointAfterWrite = yield* startCheckpointWorker(options.filename);
    if (checkpointAfterWrite !== undefined) {
      yield* opened.executeUnprepared(
        `PRAGMA wal_autocheckpoint = ${WRITER_BACKSTOP_FRAMES}`,
        [],
        undefined,
      );
    }
  }
  const readerPool = { unavailable: false };
  const readers =
    options.readerWorker && isFileDatabase
      ? yield* Effect.forEach(Array.from({ length: READER_POOL_SIZE }), () =>
          Effect.map(
            Effect.all([makeReader(options.filename, readerPool), Semaphore.make(1)]),
            ([acquire, lock]) => ({
              acquire,
              lock,
              claims: 0,
            }),
          ),
        )
      : [];

  interface Target {
    readonly name: Acquired["connection"];
    readonly lock: Semaphore.Semaphore;
    readonly connection: Connection;
  }
  const writer = Effect.map(writerConnection, (connection): Target => ({
    name: "writer",
    lock: semaphore,
    connection,
  }));
  let activeWriter: ConnectionOwner | undefined;
  // Callers must run route uninterruptibly and pass `claimed` a finalizer that runs `release` once.
  const route = (claimed: (release: Effect.Effect<void>) => Effect.Effect<void>) =>
    Effect.withFiber((fiber): Effect.Effect<Target, SqlError> => {
      if (readers.length === 0 || readerPool.unavailable || !Context.get(fiber.context, ReadOnly)) {
        return writer;
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
        Effect.flatMap(reader.acquire, (readerConnection) =>
          readerConnection === undefined
            ? writer
            : Effect.succeed<Target>({
                name: "reader",
                lock: reader.lock,
                connection: readerConnection,
              }),
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
    target: Target,
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
      return target.lock.withPermits(1)(useOwnedConnection);
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

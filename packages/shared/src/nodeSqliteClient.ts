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
  /**
   * Read-only worker connections for `readOnly` work; 0 or unset sends it to the writer.
   * Ignored for in-memory databases, which a second connection cannot share.
   */
  readonly readers?: number | undefined;
  /** Four readers when `readers` is unset. */
  readonly readerWorker?: boolean | undefined;
  readonly readerStartupTimeout?: Duration.Input | undefined;
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

const Background = Context.Reference<boolean>("@t3tools/shared/nodeSqliteClient/Background", {
  defaultValue: () => false,
});

/**
 * `readOnly` for long scans, such as a full snapshot or a sweep. Together they
 * hold at most all readers but one, so a short read never queues behind them.
 */
export const readOnlyBackground = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => readOnly(Effect.provideService(effect, Background, true));

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

// A reader refuses a database outside WAL mode with this code; retrying cannot change that.
const NOT_WAL = "ERR_SQLITE_NOT_WAL";

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
  // Every reader has its own page cache, while the OS file cache is shared by
  // all of them, so a larger cache mostly duplicates it once per reader. Memory
  // mapping would count every page a full scan touches as RSS, and an I/O
  // error under a mapping crashes the process instead of failing the query.
  if (workerData.reader) next.exec("PRAGMA cache_size = -2000; PRAGMA mmap_size = 0;");
  // Reads the header, so a file that is not a database fails here rather than on first use.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  if (workerData.requireWal && mode !== "wal") {
    throw Object.assign(new Error("database uses journal_mode " + mode + ", not wal"), { code: ${JSON.stringify(NOT_WAL)} });
  }
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
  const { id, sql, params, cached, values, raw, safeIntegers, received, savepoints } = request;
  let operation = "open";
  let iterator;
  try {
    if (db === undefined) throw new Error("database connection is unavailable");
    operation = "execute";
    for (const savepoint of savepoints) db.exec(savepoint);
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      let rows = [];
      let bytes = 0;
      let pendingBatch = false;
      iterator = statement.iterate(...params);
      for (const row of iterator) {
        let rowBytes = 0;
        for (const key in row) {
          const value = row[key];
          rowBytes += typeof value === "string" ? value.length * 2
            : ArrayBuffer.isView(value) ? value.byteLength : 8;
        }
        if (rows.length > 0 && (rows.length >= 16384 || bytes + rowBytes > 8 * 1024 * 1024)) {
          // Build the next batch during receipt, but allow only one unacknowledged message.
          if (pendingBatch) Atomics.wait(received, 0, 0);
          Atomics.store(received, 0, 0);
          parentPort.postMessage({ id, rows, more: true });
          rows = [];
          bytes = 0;
          pendingBatch = true;
        }
        rows.push(row);
        bytes += rowBytes;
      }
      if (pendingBatch) Atomics.wait(received, 0, 0);
      parentPort.postMessage({ id, rows });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [] });
    }
  } catch (error) {
    // A step that throws leaves its statement active; an active write blocks every later COMMIT.
    try {
      iterator?.return();
    } catch {}
    // A failed iterator can report its previous SQLite error when the statement is reused.
    statements.delete(sql);
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
  | { readonly id: number; readonly rows: ReadonlyArray<any>; readonly more?: boolean }
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
const READER_RETRY_DELAY = Duration.seconds(1);
const READER_RETRY_MAX_DELAY = Duration.minutes(1);

// Bind transactions to one worker; fail after its exit instead of resuming outside the transaction on a replacement.
const makeWorkerConnection = Effect.fnUntraced(function* (options: {
  readonly filename: string;
  readonly role: "reader" | "writer";
  readonly readOnly: boolean;
  readonly onReply?: () => void;
  readonly startupTimeout?: Duration.Duration;
}) {
  const label = options.role === "reader" ? "Database reader" : "Database writer";
  const readOnly = options.readOnly;
  const startupTimeout = options.startupTimeout ?? Duration.seconds(10);
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<WorkerStartup>;
      }
    | undefined;
  let nextRequestId = 0;
  // Materialize nested savepoints with the next statement; empty jobs need no worker round trip.
  const pendingSavepoints: string[] = [];
  // A replacement writer would lose the pragmas callers set on it, such as foreign_keys.
  let writerStopped: string | undefined;

  const start = () => {
    const worker = new NodeWorkerThreads.Worker(workerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        readOnly,
        reader: options.role === "reader",
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
      {
        readonly endsTransaction: boolean;
        readonly received: Int32Array;
        readonly rows: Array<unknown>;
        readonly resume: (reply: WorkerReply) => void;
      }
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
      if ("rows" in reply && reply.more) {
        for (const row of reply.rows) request.rows.push(row);
        Atomics.store(request.received, 0, 1);
        Atomics.notify(request.received, 0);
        return;
      }
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      options.onReply?.();
      if ("rows" in reply && request.rows.length > 0) {
        for (const row of reply.rows) request.rows.push(row);
        request.resume({ id: reply.id, rows: request.rows });
      } else {
        request.resume(reply);
      }
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
          const received = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
          pending.set(id, {
            endsTransaction,
            received,
            rows: [],
            resume: (reply) =>
              resume(
                "rows" in reply
                  ? Effect.succeed(reply.rows)
                  : Effect.fail(failedWith(reply.error, reply.error.operation)),
              ),
          });
          if (pending.size === 1) worker.ref();
          const cached = input.cached && !hasLargeBinding(input.params);
          const message = {
            id,
            safeIntegers,
            ...input,
            cached,
            received,
            savepoints: [...pendingSavepoints],
          };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage(message);
          // An unsent savepoint must stay queued, or its rollback would target an older sibling's.
          pendingSavepoints.length = 0;
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
        const effect = Effect.suspend(() => {
          if (!readOnly && /^SAVEPOINT effect_sql_\d+$/.test(statement)) {
            pendingSavepoints.push(statement);
            return Effect.succeed([]);
          }
          const rollback = /^ROLLBACK TO SAVEPOINT (effect_sql_\d+)$/.exec(statement);
          if (rollback !== null) {
            const pending = pendingSavepoints.lastIndexOf(`SAVEPOINT ${rollback[1]}`);
            if (pending !== -1) {
              pendingSavepoints.splice(pending);
              return Effect.succeed([]);
            }
          }
          if (statement === "COMMIT" || statement === "ROLLBACK") pendingSavepoints.length = 0;
          return request({
            sql: statement,
            params: params ?? [],
            cached: false,
            values: false,
            raw: false,
          });
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
            ? Effect.timeoutOption(started, startupTimeout)
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
              message: `${label} did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
            },
            "open",
          ),
        );
      },
    );
  });
});

const startFailure = (error: SqlError) => {
  const cause = error.reason.cause;
  return {
    reason: cause instanceof Error ? cause.message : error.message,
    permanent: Predicate.hasProperty(cause, "code") && cause.code === NOT_WAL,
  };
};

interface ReaderLease {
  readonly connection: Connection;
  readonly release: Effect.Effect<void>;
}

/**
 * Up to `size` workers, each lent to one borrower or transaction at a time.
 * WAL gives every read its own snapshot, so readers never block each other or
 * the writer, and a read that starts after a commit sees that commit.
 */
const makeReaderPool = Effect.fnUntraced(function* (
  filename: string,
  size: number,
  startupTimeout: Duration.Duration,
) {
  const slots = yield* Effect.forEach(Array.from({ length: size }), () =>
    makeWorkerConnection({ filename, role: "reader", readOnly: true, startupTimeout }),
  );
  // Last in, first out: sequential reads keep reusing one warm worker, and the
  // others start only when reads overlap.
  const idle = [...slots];
  const permits = yield* Semaphore.make(size);
  const backgroundPermits = yield* Semaphore.make(Math.max(1, size - 1));
  // A reader that cannot start turns off the whole pool, so leasing never picks a dead slot,
  // until one background retry starts it again.
  let unavailable = false;
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();

  const recover = (
    acquire: (typeof slots)[number],
    delay: Duration.Duration,
  ): Effect.Effect<void> =>
    Effect.sleep(delay).pipe(
      Effect.andThen(acquire),
      Effect.matchEffect({
        onSuccess: () =>
          Effect.suspend(() => {
            unavailable = false;
            return Effect.logInfo(
              "SQLite reader workers available again; reads use the reader workers",
            );
          }),
        onFailure: (error) => {
          const { reason, permanent } = startFailure(error);
          return permanent
            ? Effect.logInfo(
                "SQLite reader worker retries stopped permanently; reads use the writer",
                { reason },
              )
            : recover(acquire, Duration.min(Duration.times(delay, 2), READER_RETRY_MAX_DELAY));
        },
      }),
    );

  const ready = (
    acquire: (typeof slots)[number],
    restore: typeof Effect.interruptible,
  ): Effect.Effect<Connection | undefined> =>
    Effect.suspend(() =>
      unavailable
        ? Effect.undefined
        : // The startup wait follows the caller's mask, not readOnly's, which may sit outside it.
          Effect.provideService(acquire, ReadOnly, restore).pipe(
            Effect.map((connection) => (unavailable ? undefined : connection)),
            Effect.catch((error) => {
              if (unavailable) return Effect.undefined;
              unavailable = true;
              const { reason, permanent } = startFailure(error);
              // Pool state belongs to the client: never log or retry with the failed read's services.
              return Effect.logWarning("SQLite reader workers unavailable; reads use the writer", {
                reason,
              }).pipe(
                Effect.andThen(
                  permanent
                    ? Effect.void
                    : Effect.forkIn(recover(acquire, READER_RETRY_DELAY), scope),
                ),
                Effect.updateContext((_: Context.Context<never>) => context),
                Effect.as(undefined),
              );
            }),
          ),
    );

  /**
   * Run masked; `restore` carries the caller's interruption policy to the
   * waits. Undefined means the workers cannot open the database and the caller
   * should use the writer.
   */
  const lease = (
    restore: typeof Effect.interruptible,
    background: boolean,
  ): Effect.Effect<ReaderLease | undefined> =>
    Effect.suspend(() => {
      if (unavailable) return Effect.undefined;
      const enterLane = background ? restore(backgroundPermits.take(1)) : Effect.void;
      const leaveLane = background ? Effect.asVoid(backgroundPermits.release(1)) : Effect.void;
      const take = Effect.andThen(
        enterLane,
        restore(permits.take(1)).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : leaveLane)),
        ),
      );
      return Effect.flatMap(take, () => {
        const slot = idle.pop()!;
        const release = Effect.suspend(() => {
          idle.push(slot);
          return permits.release(1);
        }).pipe(Effect.andThen(leaveLane));
        return ready(slot, restore).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) && exit.value !== undefined ? Effect.void : release,
          ),
          Effect.map((connection) => connection && { connection, release }),
        );
      });
    });

  return { lease };
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
// SQLITE_BUSY and SQLITE_LOCKED, extended codes included. Another process holding the file past
// busy_timeout (WAL recovery after a crash, an exclusive-mode connection) is transient, so the
// next write retries instead of handing every checkpoint to the writer for good.
const isLockError = (error) =>
  typeof error?.errcode === "number" && ((error.errcode & 0xff) === 5 || (error.errcode & 0xff) === 6);
const open = () => {
  const opened = new DatabaseSync(workerData.filename);
  try {
    opened.exec("PRAGMA busy_timeout = 5000;");
    // macOS requires F_FULLFSYNC to flush the drive cache.
    opened.exec("PRAGMA checkpoint_fullfsync = ON;");
    frames = opened.prepare("PRAGMA wal_checkpoint(NOOP)");
    passive = opened.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  } catch (error) {
    opened.close();
    throw error;
  }
  db = opened;
};
const check = (force) => {
  if (db === undefined) open();
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
    if (isLockError(error)) {
      parentPort.postMessage({ type: "locked" });
      return;
    }
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
  const readerCount = options.readers ?? (options.readerWorker === true ? READER_POOL_SIZE : 0);
  const readers =
    readerCount > 0 && isFileDatabase
      ? yield* makeReaderPool(
          options.filename,
          readerCount,
          Duration.fromInputUnsafe(options.readerStartupTimeout ?? "10 seconds"),
        )
      : undefined;
  const isReadOnly = (fiber: Fiber.Fiber<unknown, unknown>) =>
    readers !== undefined && Context.get(fiber.context, ReadOnly) !== undefined;

  let activeWriter: ConnectionOwner | undefined;
  const acquired = (
    connection: Acquired["connection"],
    clock: Clock.Clock,
    start: bigint,
  ): Acquired => ({
    connection,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const borrowWriter: Borrower = (use) =>
    Effect.withFiber((fiber) => {
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const ownerAtWaitStart = activeWriter;
      const owner = connectionOwner(fiber);
      return Effect.flatMap(writerConnection, (connection) =>
        semaphore.withPermits(1)(
          Effect.onExit(
            Effect.suspend(() => {
              activeWriter = owner;
              if (
                fiber.getRef(References.TracerEnabled) &&
                fiber.getRef(Statement.SpanPropagationEnabled)
              ) {
                annotateAcquired(fiber, acquired("writer", clock, start), ownerAtWaitStart);
              }
              return use(connection);
            }),
            () =>
              Effect.sync(() => {
                if (activeWriter === owner) activeWriter = undefined;
              }),
          ),
        ),
      );
    });
  const borrower: Borrower = (use) =>
    Effect.withFiber((fiber) => {
      if (readers === undefined || !isReadOnly(fiber)) return borrowWriter(use);
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      return Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(readers.lease(restore, fiber.getRef(Background)), (lease) =>
          lease === undefined
            ? restore(borrowWriter(use))
            : restore(
                Effect.suspend(() => {
                  if (
                    fiber.getRef(References.TracerEnabled) &&
                    fiber.getRef(Statement.SpanPropagationEnabled)
                  ) {
                    annotateAcquired(fiber, acquired("reader", clock, start));
                  }
                  return use(lease.connection);
                }),
              ).pipe(Effect.ensuring(lease.release)),
        ),
      );
    });

  const acquireWriter = Effect.flatMap(writerConnection, (connection) =>
    Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const pending = fiber.getRef(TransactionAcquire);
      const ownerAtWaitStart = activeWriter;
      const owner = connectionOwner(fiber);
      const acquire = Effect.tap((pending?.restore ?? restore)(semaphore.take(1)), () => {
        activeWriter = owner;
        if (pending !== undefined) {
          pending.acquired = acquired("writer", clock, start);
          pending.ownerAtWaitStart = ownerAtWaitStart;
        }
        return Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            if (activeWriter === owner) activeWriter = undefined;
          }).pipe(Effect.andThen(semaphore.release(1))),
        );
      });
      return Effect.as(
        // A scheduler yield after taking the permit must not precede its release finalizer.
        Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
        connection,
      );
    }),
  );
  const transactionAcquirer = Effect.withFiber((fiber) => {
    if (readers === undefined || !isReadOnly(fiber)) return acquireWriter;
    const leased = Effect.uninterruptibleMask((restore) => {
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const pending = fiber.getRef(TransactionAcquire);
      const acquire = Effect.flatMap(
        readers.lease(pending?.restore ?? restore, fiber.getRef(Background)),
        (lease) => {
          if (lease === undefined) return Effect.undefined;
          if (pending !== undefined) {
            pending.acquired = acquired("reader", clock, start);
            pending.ownerAtWaitStart = undefined;
          }
          return Effect.as(Scope.addFinalizer(scope, lease.release), lease.connection);
        },
      );
      return Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true);
    });
    return Effect.filterOrElse(leased, Predicate.isNotUndefined, () => acquireWriter);
  });

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

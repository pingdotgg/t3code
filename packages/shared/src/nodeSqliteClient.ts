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
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /** Ignored for in-memory databases, which cannot share a second connection. */
  readonly readerWorker?: boolean | undefined;
  readonly readerStartupTimeout?: Duration.Input | undefined;
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
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: true,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  parentPort.postMessage({ type: "ready" });
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
parentPort.on("message", ({ id, sql, params, cached, values, raw, safeIntegers }) => {
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database reader is unavailable");
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
    parentPort.postMessage({
      id,
      error: {
        operation,
        message: String(error && error.message ? error.message : error),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
    });
  }
});
`;

interface ReaderRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

type ReaderStartup =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly message: string };

type ReaderReply =
  | { readonly id: number; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly error: {
        readonly operation: "open" | "prepare" | "execute";
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
      };
    };

const readerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

// Read-transaction cleanup succeeds after worker exit because it can no longer change anything.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

// Bind transactions to one worker; fail after its exit instead of resuming outside the transaction on a replacement.
const makeReader = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<ReaderStartup>;
      }
    | undefined;
  let unavailable = false;
  let nextRequestId = 0;

  const start = () => {
    const worker = new NodeWorkerThreads.Worker(readerWorkerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        allowExtension: options.allowExtension ?? false,
        prepareCacheSize: options.prepareCacheSize ?? 200,
      },
    });
    let announce: (startup: ReaderStartup) => void = () => {};
    const started = new Promise<ReaderStartup>((resolve) => {
      announce = resolve;
    });
    let stoppedMessage: string | undefined;
    const pending = new Map<
      number,
      { readonly endsTransaction: boolean; readonly resume: (reply: ReaderReply) => void }
    >();
    const stop = (message: string) => {
      stoppedMessage = message;
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
    worker.on("message", (reply: ReaderReply | ReaderStartup) => {
      if ("type" in reply) {
        announce(reply);
        if (pending.size === 0) worker.unref();
        return;
      }
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      request.resume(reply);
    });
    worker.on("error", (cause) => stop(`Database reader failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`Database reader exited with code ${code}`));

    const request = (input: ReaderRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const endsTransaction = endsReadTransaction(input.sql);
        if (stoppedMessage !== undefined) {
          return endsTransaction
            ? Effect.succeed([])
            : Effect.fail(
                failed(new Error(stoppedMessage), readerFailureMessages.execute, "execute"),
              );
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          const id = nextRequestId++;
          pending.set(id, {
            endsTransaction,
            resume: (reply) => {
              if ("rows" in reply) {
                resume(Effect.succeed(reply.rows));
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
            },
          });
          if (pending.size === 1) worker.ref();
          const cached = input.cached && !hasLargeBinding(input.params);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, cached });
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

  const startupTimeout = Duration.fromInputUnsafe(
    options.readerStartupTimeout ?? Duration.seconds(10),
  );

  const turnOff = (reader: typeof current, reason: string) =>
    Effect.suspend(() => {
      if (reader !== undefined) {
        if (current === reader) current = undefined;
        void reader.worker.terminate();
      }
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - The connection result distinguishes undefined from void.
      if (unavailable) return Effect.succeed(undefined);
      unavailable = true;
      return Effect.logWarning("SQLite reader worker unavailable; reads use the main connection", {
        reason,
      }).pipe(Effect.as(undefined));
    });

  return Effect.suspend((): Effect.Effect<Connection | undefined> => {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - The connection result distinguishes undefined from void.
    if (unavailable) return Effect.succeed(undefined);
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
        unavailable || current !== reader
          ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - The connection result distinguishes undefined from void.
            Effect.succeed(undefined)
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
const CHECKPOINT_BACKPRESSURE_FRAMES = 10 * CHECKPOINT_FRAMES;

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
const schedule = (state, blocked) => {
  if (blocked || state.log - state.checkpointed >= workerData.frames) {
    idle = setTimeout(() => check(undefined, undefined, true), workerData.idleMs);
  }
};
const check = (id, nextJournalSizeLimit, force, nextGeneration = generation) => {
  initialize();
  if (Number.isSafeInteger(nextGeneration)) generation = Math.max(generation, nextGeneration);
  if (Number.isSafeInteger(nextJournalSizeLimit)) journalSizeLimit = nextJournalSizeLimit;
  let state = frames.get();
  const oversized = exceedsSizeLimit();
  if (force || state.log - state.checkpointed >= workerData.frames || oversized) {
    checkpoint.get();
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
  const blocked = (atCeiling(state) || oversized) && state.checkpointed < state.log;
  parentPort.postMessage({ type: "checkpoint", id, generation, ...state, blocked });
  schedule(state, blocked);
};
const finishTruncate = (truncateId) => {
  if (pendingTruncate === undefined || pendingTruncate.truncateId !== truncateId) return;
  const pending = pendingTruncate;
  parentPort.postMessage({ type: "truncate-start", truncateId });
  let busy;
  // Admission is paused here; a pinned reader must not make truncation wait.
  db.exec("PRAGMA busy_timeout = 0;");
  try {
    busy = truncate.get().busy !== 0;
  } finally {
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  const state = frames.get();
  const blocked = (atCeiling(state) && (busy || state.checkpointed < state.log)) || exceedsSizeLimit();
  pendingTruncate = undefined;
  parentPort.postMessage({
    type: "checkpoint",
    id: pending.checkId,
    generation: pending.generation,
    truncateId,
    ...state,
    blocked,
  });
  while (pendingBarriers > 0) {
    pendingBarriers--;
    parentPort.postMessage("barrier");
  }
  schedule(state, blocked);
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
  const version = String(writer.prepare("SELECT sqlite_version() AS version").get()?.version);
  const [major = 0, minor = 0] = version.split(".").map(Number);
  // Older SQLite treats NOOP as PASSIVE, which would checkpoint on the writer.
  if (major < 3 || (major === 3 && minor < 51)) {
    yield* warn(`SQLite ${version} has no NOOP checkpoint`);
    return undefined;
  }
  const frames = writer.prepare("PRAGMA wal_checkpoint(NOOP)");
  const sizeLimit = writer.prepare("PRAGMA journal_size_limit");
  const started = yield* Effect.try(
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
  ).pipe(Effect.result);
  if (Result.isFailure(started)) {
    yield* warn(String(started.failure.cause));
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
    !stopped &&
    !writer.isTransaction &&
    (unknown || blocked || truncate !== undefined || log >= CHECKPOINT_BACKPRESSURE_FRAMES);
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

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
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
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
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
  const acquireReader =
    options.readerWorker && isFileDatabase ? yield* makeReader(options) : undefined;
  const readerSemaphore = yield* Semaphore.make(1);

  const writer = { name: "writer" as const, lock: semaphore, connection };
  let activeWriter: ConnectionOwner | undefined;
  const route = Effect.withFiber((fiber) =>
    acquireReader !== undefined && Context.get(fiber.context, ReadOnly)
      ? Effect.map(acquireReader, (readerConnection) =>
          readerConnection === undefined
            ? writer
            : { name: "reader" as const, lock: readerSemaphore, connection: readerConnection },
        )
      : Effect.succeed(writer),
  );

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
    Effect.flatMap(route, (target) =>
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
      }),
    );
  const transactionAcquirer = Effect.flatMap(route, (target) =>
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
  );

  const client = yield* Client.make({
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
    transformRows,
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

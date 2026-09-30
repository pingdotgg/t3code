/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const DEFAULT_READ_POOL_SIZE = 4;

const WORKER_SOURCE = String.raw`
(async () => {
const { parentPort, workerData } = await import("node:worker_threads");
const { DatabaseSync } = await import("node:sqlite");

const database = new DatabaseSync(workerData.filename, {
  readOnly: workerData.readOnly,
  allowExtension: workerData.allowExtension,
});
if (!workerData.readOnly && !workerData.disableWAL) {
  database.exec("PRAGMA journal_mode = WAL");
}
const statements = new Map();

function prepare(sql) {
  const cached = statements.get(sql);
  if (cached !== undefined) {
    statements.delete(sql);
    statements.set(sql, cached);
    return cached;
  }
  const statement = database.prepare(sql);
  statements.set(sql, statement);
  if (statements.size > workerData.prepareCacheSize) {
    statements.delete(statements.keys().next().value);
  }
  return statement;
}

parentPort.on("message", (request) => {
  if (request.type === "close") {
    database.close();
    parentPort.postMessage({ type: "closed" });
    return;
  }

  try {
    const statement = prepare(request.sql);
    statement.setReadBigInts(request.safeIntegers);
    const hasRows = statement.columns().length > 0;
    let result;
    if (hasRows) {
      statement.setReturnArrays(request.mode === "values");
      try {
        result = statement.all(...request.params);
      } finally {
        if (request.mode === "values") statement.setReturnArrays(false);
      }
    } else {
      const runResult = statement.run(...request.params);
      result = request.mode === "raw" ? runResult : [];
    }
    parentPort.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      error: {
        name: error?.name,
        message: error?.message ?? String(error),
        stack: error?.stack,
        code: error?.code,
        errcode: error?.errcode,
        errstr: error?.errstr,
      },
    });
  }
});
parentPort.postMessage({ type: "ready" });
})();
`;

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = Context.Service<Client.SqlClient>("t3/persistence/NodeSqliteClient");

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly disableWAL?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly readPoolSize?: number | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      `Node.js ${process.versions.node} is missing required node:sqlite APIs ` +
        `(StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`,
    );
  }
  return Effect.void;
};

const isReadOnlySql = (sql: string): boolean => {
  const trimmed = sql.trimStart();
  if (/^(?:SELECT|EXPLAIN)\b/i.test(trimmed)) return true;
  if (!/^WITH\b/i.test(trimmed)) return false;

  let depth = 0;
  let index = 0;
  while (index < trimmed.length) {
    const char = trimmed[index]!;
    const next = trimmed[index + 1];
    if (char === "-" && next === "-") {
      index = trimmed.indexOf("\n", index + 2);
      if (index === -1) return false;
      continue;
    }
    if (char === "/" && next === "*") {
      index = trimmed.indexOf("*/", index + 2);
      if (index === -1) return false;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      index += 1;
      while (index < trimmed.length) {
        if (trimmed[index] === closing) {
          if (trimmed[index + 1] === closing && closing !== "]") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z]/.test(char)) {
      const start = index;
      while (index < trimmed.length && /[A-Za-z]/.test(trimmed[index]!)) index += 1;
      const token = trimmed.slice(start, index).toUpperCase();
      if (token === "SELECT") return true;
      if (["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(token)) return false;
      continue;
    }
    index += 1;
  }
  return false;
};

const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = openDatabase();
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => db.close()),
    );

    const statementReaderCache = new WeakMap<StatementSync, boolean>();
    const hasRows = (statement: StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepareCache = yield* Cache.make({
      capacity: options.prepareCacheSize ?? 200,
      timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
      lookup: (sql: string) =>
        Effect.try({
          try: () => db.prepare(sql),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to prepare statement",
                operation: "prepare",
              }),
            }),
        }),
    });

    const runStatement = (statement: StatementSync, params: ReadonlyArray<unknown>, raw: boolean) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
        try {
          if (hasRows(statement)) {
            return Effect.succeed(statement.all(...(params as any)));
          }
          const result = statement.run(...(params as any));
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to execute statement",
                operation: "execute",
              }),
            }),
          );
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.acquireUseRelease(
        Cache.get(prepareCache, sql),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                // Safe to cast to array after we've setReturnArrays(true)
                return statement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
              }
              statement.run(...(params as any));
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, {
                  message: "Failed to execute statement",
                  operation: "execute",
                }),
              }),
          }),
        (statement) =>
          Effect.sync(() => {
            if (hasRows(statement)) {
              statement.setReturnArrays(false);
            }
          }),
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
      executeUnprepared(sql, params, rowTransform) {
        // Route through the shared prepare cache: a fresh db.prepare() per call
        // leaks native StatementSync handles on this long-lived connection.
        const effect = run(sql, params ?? [], false);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die("executeStream not implemented");
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;

  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

interface WorkerRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly mode: "rows" | "raw" | "values";
  readonly safeIntegers: boolean;
}

interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
    readonly code?: string;
    readonly errcode?: number;
    readonly errstr?: string;
  };
}

interface WorkerClient {
  readonly execute: (request: WorkerRequest) => Effect.Effect<unknown, SqlError>;
  readonly close: Effect.Effect<void>;
}

const makeWorkerClient = Effect.fn("makeWorkerClient")(function* (
  options: SqliteClientConfig,
  readOnly: boolean,
) {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      filename: options.filename,
      readOnly,
      allowExtension: options.allowExtension ?? false,
      disableWAL: options.disableWAL ?? false,
      prepareCacheSize: options.prepareCacheSize ?? 200,
    },
  });
  const ready = Promise.withResolvers<void>();
  let requestId = 0;
  const pending = new Map<number, (effect: Effect.Effect<unknown, SqlError>) => void>();

  const failPending = (cause: unknown) => {
    const error = new SqlError({
      reason: classifySqliteError(cause, {
        message: "SQLite worker failed",
        operation: "execute",
      }),
    });
    for (const resume of pending.values()) {
      resume(Effect.fail(error));
    }
    pending.clear();
  };

  worker.on("message", (response: WorkerResponse | { readonly type: "closed" | "ready" }) => {
    if ("type" in response) {
      if (response.type === "ready") ready.resolve();
      return;
    }
    const resume = pending.get(response.id);
    if (resume === undefined) return;
    pending.delete(response.id);
    if (response.ok) {
      resume(Effect.succeed(response.result));
      return;
    }
    const cause = Object.assign(new Error(response.error?.message ?? "SQLite worker failed"), {
      name: response.error?.name,
      stack: response.error?.stack,
      code: response.error?.code,
      errcode: response.error?.errcode,
      errstr: response.error?.errstr,
    });
    resume(
      Effect.fail(
        new SqlError({
          reason: classifySqliteError(cause, {
            message: "Failed to execute statement",
            operation: "execute",
          }),
        }),
      ),
    );
  });
  worker.on("error", (cause) => {
    ready.reject(cause);
    failPending(cause);
  });
  worker.on("exit", (code) => {
    if (code !== 0 && pending.size > 0) {
      failPending(new Error(`SQLite worker exited with code ${code}`));
    }
  });
  yield* Effect.promise(() => ready.promise);

  const execute = (request: WorkerRequest): Effect.Effect<unknown, SqlError> =>
    Effect.callback((resume) => {
      const id = ++requestId;
      pending.set(id, resume);
      // worker_threads messages are process-local and do not accept a target origin.
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ id, ...request });
      return Effect.sync(() => {
        pending.delete(id);
      });
    });

  return {
    execute,
    close: Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
  } satisfies WorkerClient;
});

const makeWorkerBacked = Effect.fn("makeWorkerBacked")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();
  const scope = yield* Effect.scope;
  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;
  const writer = yield* makeWorkerClient(options, options.readonly ?? false);
  const readPoolSize =
    options.readonly || options.disableWAL
      ? 0
      : Math.max(1, Math.floor(options.readPoolSize ?? DEFAULT_READ_POOL_SIZE));
  const readers = yield* Effect.forEach(Array.from({ length: readPoolSize }), () =>
    makeWorkerClient(options, true),
  );
  yield* Scope.addFinalizer(
    scope,
    Effect.forEach([writer, ...readers], (client) => client.close, {
      concurrency: "unbounded",
      discard: true,
    }),
  );

  let nextReader = 0;
  const writerSemaphore = yield* Semaphore.make(1);
  const request = (
    client: WorkerClient,
    sql: string,
    params: ReadonlyArray<unknown>,
    mode: WorkerRequest["mode"],
  ) =>
    Effect.withFiber((fiber) =>
      client.execute({
        sql,
        params,
        mode,
        safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
      }),
    );
  const route = (sql: string) => {
    if (readers.length === 0 || !isReadOnlySql(sql)) return writer;
    const reader = readers[nextReader % readers.length]!;
    nextReader += 1;
    return reader;
  };
  const runRouted = (sql: string, params: ReadonlyArray<unknown>, mode: WorkerRequest["mode"]) => {
    const client = route(sql);
    const effect = request(client, sql, params, mode);
    return client === writer ? writerSemaphore.withPermits(1)(effect) : effect;
  };
  const makeConnection = (
    run: (
      sql: string,
      params: ReadonlyArray<unknown>,
      mode: WorkerRequest["mode"],
    ) => Effect.Effect<unknown, SqlError>,
  ): Connection =>
    identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = run(sql, params, "rows") as Effect.Effect<ReadonlyArray<any>, SqlError>;
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return run(sql, params, "raw");
      },
      executeValues(sql, params) {
        return run(sql, params, "values") as Effect.Effect<
          ReadonlyArray<ReadonlyArray<unknown>>,
          SqlError
        >;
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = run(sql, params ?? [], "rows") as Effect.Effect<
          ReadonlyArray<any>,
          SqlError
        >;
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die("executeStream not implemented");
      },
    });

  const routedConnection = makeConnection(runRouted);
  const transactionConnection = makeConnection((sql, params, mode) =>
    request(writer, sql, params, mode),
  );
  const acquirer = Effect.succeed(routedConnection);
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const transactionScope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(writerSemaphore.take(1)), () =>
        Scope.addFinalizer(transactionScope, writerSemaphore.release(1)),
      ),
      transactionConnection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  options.filename === ":memory:"
    ? makeWithDatabase(
        options,
        () =>
          new DatabaseSync(":memory:", {
            allowExtension: options.allowExtension ?? false,
          }),
      )
    : makeWorkerBacked(options);

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
      ),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makeMemory(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

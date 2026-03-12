/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges,
  type StatementSync,
} from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = ServiceMap.Service<Client.SqlClient>("t3/persistence/NodeSqliteClient");

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

const makeWithDatabase = (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function* () {
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
            catch: (cause) => new SqlError({ cause, message: "Failed to prepare statement" }),
          }),
      });

      type SqliteRow = Readonly<Record<string, SQLOutputValue>>;
      type SqliteRawResult = StatementResultingChanges;

      const isSqlInputValue = (value: unknown): value is SQLInputValue =>
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "bigint" ||
        value instanceof Uint8Array;

      const toSqlParam = (param: unknown): SQLInputValue => {
        if (param === undefined) {
          return null;
        }
        if (typeof param === "boolean") {
          return param ? 1 : 0;
        }
        if (isSqlInputValue(param)) {
          return param;
        }
        throw new SqlError({
          cause: new TypeError(`Unsupported sqlite parameter type: ${typeof param}`),
          message: "Failed to execute statement",
        });
      };

      const toSqlParams = (params: ReadonlyArray<unknown>): ReadonlyArray<SQLInputValue> => {
        const normalized: Array<SQLInputValue> = [];
        for (const param of params) {
          normalized.push(toSqlParam(param));
        }
        return normalized;
      };

      const runStatement = (
        statement: StatementSync,
        params: ReadonlyArray<unknown>,
        raw: boolean,
      ): Effect.Effect<ReadonlyArray<SqliteRow> | SqliteRawResult, SqlError> =>
        Effect.withFiber<ReadonlyArray<SqliteRow> | SqliteRawResult, SqlError>((fiber) => {
          statement.setReadBigInts(Boolean(ServiceMap.get(fiber.services, Client.SafeIntegers)));
          try {
            const sqlParams = toSqlParams(params);
            if (hasRows(statement)) {
              return Effect.succeed(statement.all(...sqlParams));
            }
            const result = statement.run(...sqlParams);
            return Effect.succeed(raw ? result : []);
          } catch (cause) {
            return Effect.fail(new SqlError({ cause, message: "Failed to execute statement" }));
          }
        });

      const runRows = (sql: string, params: ReadonlyArray<unknown>) =>
        Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
          runStatement(statement, params, false).pipe(
            Effect.map((result) => (Array.isArray(result) ? result : [])),
          ),
        );

      const runRaw = (sql: string, params: ReadonlyArray<unknown>) =>
        Effect.flatMap(Cache.get(prepareCache, sql), (statement) => runStatement(statement, params, true));

      const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
        Effect.acquireUseRelease(
          Cache.get(prepareCache, sql),
          (statement) =>
            Effect.try({
              try: () => {
                const sqlParams = toSqlParams(params);
                if (hasRows(statement)) {
                  statement.setReturnArrays(true);
                  return statement
                    .all(...sqlParams)
                    .map((row) => Object.values(row) as ReadonlyArray<unknown>);
                }
                statement.run(...sqlParams);
                return [];
              },
              catch: (cause) => new SqlError({ cause, message: "Failed to execute statement" }),
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
          const effect = runRows(sql, params);
          return rowTransform ? Effect.map(effect, rowTransform) : effect;
        },
        executeRaw(sql, params) {
          return runRaw(sql, params);
        },
        executeValues(sql, params) {
          return runValues(sql, params);
        },
        executeUnprepared(sql, params, rowTransform) {
          const effect = runStatement(db.prepare(sql), params ?? [], false).pipe(
            Effect.map((result) => (Array.isArray(result) ? result : [])),
          );
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
      const scope = ServiceMap.getUnsafe(fiber.services, Scope.Scope);
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () =>
          Scope.addFinalizer(scope, semaphore.release(1)),
        ),
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

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () =>
      new DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      }),
  );

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
  Layer.effectServices(
    Config.unwrap(config)
      .asEffect()
      .pipe(
        Effect.flatMap(make),
        Effect.map((client) =>
          ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
        ),
      ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(make(config), (client) =>
      ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(makeMemory(config), (client) =>
      ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

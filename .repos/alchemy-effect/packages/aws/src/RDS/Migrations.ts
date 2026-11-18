import {
  inlineSqlParams,
  MigrationError,
  migrationError,
  runMigrations,
  type MigrationDialect,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as rds from "@distilled.cloud/aws/rds";
import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { withMigrationConnection, type MigrationConnectionTarget } from "./MigrationConnection.ts";
import type { MigrationRunnerRequest, MigrationRunnerResponse } from "./MigrationRunnerHandler.ts";

/**
 * How migrations reach an RDS database:
 *
 * - `"data-api"` — the RDS Data API over HTTPS. Aurora clusters with the
 *   Data API enabled only; no network route needed.
 * - `"direct"` — a `pg`/`mysql2` connection from the deploying machine to
 *   the database endpoint. Needs a network route (public endpoint, VPN,
 *   bastion).
 * - an `AWS.RDS.MigrationRunner` (or any `{ functionArn }`) — a Lambda in
 *   the database's VPC opens the connection; the deploying machine only
 *   invokes it.
 */
export type MigrationsTransport = "data-api" | "direct" | { functionArn: string };

const dialects: Record<string, "postgres" | "mysql" | undefined> = {
  postgres: "postgres",
  "aurora-postgresql": "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  "aurora-mysql": "mysql",
};

/** The writer endpoint, database and credential sources of an instance. */
interface MigrationTarget {
  dialect: "postgres" | "mysql";
  host: string | undefined;
  port: number | undefined;
  database: string | undefined;
  /** The cluster ARN when the Data API is enabled on the instance's cluster. */
  dataApiArn: string | undefined;
  managedSecretArn: string | undefined;
}

const describeTarget = Effect.fn(function* (instance: rds.DBInstance) {
  const identifier = instance.DBInstanceIdentifier ?? "unknown";
  if (instance.DBClusterIdentifier) {
    const cluster = yield* rds
      .describeDBClusters({ DBClusterIdentifier: instance.DBClusterIdentifier })
      .pipe(
        Effect.map((response) => response.DBClusters?.[0]),
        Effect.catchTag("DBClusterNotFoundFault", () => Effect.undefined),
      );
    if (!cluster) {
      return yield* new MigrationError({
        message: `DB cluster '${instance.DBClusterIdentifier}' of instance '${identifier}' not found`,
      });
    }
    const engine = cluster.Engine ?? "";
    const dialect = dialects[engine];
    if (!dialect) {
      return yield* unsupportedEngine(instance.DBClusterIdentifier, engine);
    }
    return {
      dialect,
      host: cluster.Endpoint,
      port: cluster.Port,
      database: cluster.DatabaseName,
      dataApiArn: cluster.HttpEndpointEnabled ? cluster.DBClusterArn : undefined,
      managedSecretArn: cluster.MasterUserSecret?.SecretArn,
    } satisfies MigrationTarget;
  }
  const engine = instance.Engine ?? "";
  const dialect = dialects[engine];
  if (!dialect) {
    return yield* unsupportedEngine(identifier, engine);
  }
  return {
    dialect,
    host: instance.Endpoint?.Address,
    port: instance.Endpoint?.Port,
    database: instance.DBName,
    dataApiArn: undefined,
    managedSecretArn: instance.MasterUserSecret?.SecretArn,
  } satisfies MigrationTarget;
});

const unsupportedEngine = (identifier: string, engine: string) =>
  new MigrationError({
    message: `'${identifier}' runs ${engine || "an unknown engine"}; migrations support PostgreSQL, MySQL and MariaDB engines (including Aurora)`,
  });

// An auto-paused Serverless v2 writer resumes on the first request.
const resumeRetry = {
  while: (e: { readonly _tag: string }) => e._tag === "DatabaseResumingException",
  schedule: Schedule.spaced("5 seconds"),
  times: 10,
};

/**
 * The Data API as a {@link SqlExecutor}. Queries inline their params (the
 * Data API binds `:name` placeholders only), and batches run inside a
 * Data API transaction.
 */
const makeDataApiExecutor = Effect.fn(function* (options: {
  dialect: MigrationDialect;
  resourceArn: string;
  secretArn: string;
  database: string | undefined;
}) {
  const executeStatement = yield* rdsdata.executeStatement;
  const beginTransaction = yield* rdsdata.beginTransaction;
  const commitTransaction = yield* rdsdata.commitTransaction;
  const rollbackTransaction = yield* rdsdata.rollbackTransaction;
  const { dialect, resourceArn, secretArn, database } = options;

  return {
    dialect,
    query: (sql, params) =>
      executeStatement({
        resourceArn,
        secretArn,
        database,
        sql: inlineSqlParams(sql, params ?? [], dialect),
        formatRecordsAs: "JSON",
      }).pipe(
        Effect.retry(resumeRetry),
        Effect.mapError(migrationError("Data API query")),
        Effect.flatMap((result) =>
          Effect.try({
            try: () =>
              (result.formattedRecords ? JSON.parse(result.formattedRecords) : []) as Array<
                Record<string, unknown>
              >,
            catch: (cause) =>
              new MigrationError({
                message: `Data API returned malformed records: ${String(cause)}`,
                cause,
              }),
          }),
        ),
      ),
    batch: (statements) =>
      Effect.gen(function* () {
        const { transactionId } = yield* beginTransaction({
          resourceArn,
          secretArn,
          database,
        }).pipe(
          Effect.retry(resumeRetry),
          Effect.mapError(migrationError("Data API begin transaction")),
        );
        if (!transactionId) {
          return yield* new MigrationError({ message: "Data API returned no transaction id" });
        }
        yield* Effect.gen(function* () {
          yield* Effect.forEach(
            statements,
            (sql) => executeStatement({ resourceArn, secretArn, database, sql, transactionId }),
            { discard: true },
          );
          yield* commitTransaction({ resourceArn, secretArn, transactionId });
        }).pipe(
          Effect.onError(() =>
            rollbackTransaction({ resourceArn, secretArn, transactionId }).pipe(Effect.ignore),
          ),
          Effect.mapError(migrationError("Data API migration batch")),
        );
      }),
  } satisfies SqlExecutor;
});

/**
 * An in-VPC `AWS.RDS.MigrationRunner` as a {@link SqlExecutor}: every
 * query and every migration batch is one synchronous invocation that opens
 * its own connection. Params are inlined so the payload is plain SQL.
 */
const makeRunnerExecutor = Effect.fn(function* (options: {
  functionArn: string;
  target: MigrationConnectionTarget;
}) {
  const invoke = yield* Lambda.invoke;
  const { functionArn, target } = options;
  const call = (request: MigrationRunnerRequest) =>
    Effect.gen(function* () {
      const response = yield* invoke({
        FunctionName: functionArn,
        Payload: JSON.stringify(request),
      }).pipe(Effect.mapError(migrationError(`Invoking migration runner ${functionArn}`)));
      const body = response.Payload
        ? yield* response.Payload.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.mapError(
              (cause) =>
                new MigrationError({
                  message: `Failed to read the migration runner's response: ${cause.message}`,
                  cause,
                }),
            ),
          )
        : "";
      const parsed = yield* Effect.try({
        try: () => JSON.parse(body) as MigrationRunnerResponse & { errorMessage?: string },
        catch: (cause) =>
          new MigrationError({
            message: `Migration runner returned a malformed response: ${body}`,
            cause,
          }),
      });
      if (response.FunctionError) {
        return yield* new MigrationError({
          message: `Migration runner ${functionArn} failed: ${parsed.errorMessage ?? body}`,
        });
      }
      if (!parsed.ok) {
        return yield* new MigrationError({ message: parsed.message });
      }
      return parsed.rows;
    });

  return {
    dialect: target.dialect,
    query: (sql, params) =>
      call({ op: "query", target, sql: inlineSqlParams(sql, params ?? [], target.dialect) }),
    batch: (statements) => call({ op: "batch", target, statements }).pipe(Effect.asVoid),
  } satisfies SqlExecutor;
});

const readSecretCredentials = Effect.fn(function* (secretArn: string) {
  const value = yield* secretsmanager
    .getSecretValue({ SecretId: secretArn })
    .pipe(Effect.mapError(migrationError(`Reading secret ${secretArn}`)));
  const secretString =
    value.SecretString === undefined
      ? "{}"
      : typeof value.SecretString === "string"
        ? value.SecretString
        : Redacted.value(value.SecretString);
  const secret = yield* Effect.try({
    try: () => JSON.parse(secretString) as { username?: string; password?: string },
    catch: (cause) => new MigrationError({ message: `Secret ${secretArn} is not JSON`, cause }),
  });
  if (!secret.username || !secret.password) {
    return yield* new MigrationError({
      message: `Secret ${secretArn} has no "username" and "password"`,
    });
  }
  return { username: secret.username, password: secret.password };
});

/**
 * Apply migrations to the database an RDS instance serves — its own, or its
 * Aurora cluster's when it is a cluster member. Call once the instance is
 * available. Credentials, in order: `secretArn`, then `credentials`
 * (direct and Lambda transports only), then the RDS-managed master secret.
 */
export const runDBInstanceMigrations = Effect.fn(function* (options: {
  instance: rds.DBInstance;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
  transport: MigrationsTransport | undefined;
  secretArn: string | undefined;
  credentials: { username: string; password: Redacted.Redacted<string> } | undefined;
}) {
  const identifier = options.instance.DBInstanceIdentifier ?? "unknown";
  const target = yield* describeTarget(options.instance);
  const transport = options.transport ?? (target.dataApiArn ? "data-api" : "direct");

  if (transport === "data-api") {
    const resourceArn = target.dataApiArn;
    if (!resourceArn) {
      return yield* new MigrationError({
        message: options.instance.DBClusterIdentifier
          ? `DB cluster '${options.instance.DBClusterIdentifier}' does not have the Data API enabled (set enableHttpEndpoint: true)`
          : `DB instance '${identifier}' is not an Aurora cluster member; the Data API transport needs an Aurora cluster`,
      });
    }
    const secretArn = options.secretArn ?? target.managedSecretArn;
    if (!secretArn) {
      return yield* new MigrationError({
        message: `'${identifier}' has no RDS-managed master secret; pass migrationsSecretArn`,
      });
    }
    return yield* runMigrations({
      input: options.input,
      stamped: options.stamped,
      withExecutor: (apply) =>
        makeDataApiExecutor({
          dialect: target.dialect,
          resourceArn,
          secretArn,
          database: target.database,
        }).pipe(Effect.flatMap(apply)),
    });
  }

  if (!target.host || !target.port) {
    return yield* new MigrationError({ message: `'${identifier}' has no endpoint yet` });
  }
  if (target.dialect === "mysql" && !target.database) {
    return yield* new MigrationError({
      message: `'${identifier}' has no database name; set dbName (or databaseName on the cluster) to apply migrations`,
    });
  }
  const secretArn =
    options.secretArn ?? (options.credentials ? undefined : target.managedSecretArn);
  const credentials = secretArn
    ? yield* readSecretCredentials(secretArn)
    : options.credentials
      ? {
          username: options.credentials.username,
          password: Redacted.value(options.credentials.password),
        }
      : undefined;
  if (!credentials) {
    return yield* new MigrationError({
      message: `'${identifier}' has no credentials for migrations; set manageMasterUserPassword, masterUserPassword, or migrationsSecretArn`,
    });
  }
  const connection: MigrationConnectionTarget = {
    dialect: target.dialect,
    host: target.host,
    port: target.port,
    // PostgreSQL always has the `postgres` database.
    database: target.database ?? (target.dialect === "postgres" ? "postgres" : undefined),
    ...credentials,
  };

  return yield* runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) =>
      transport === "direct"
        ? withMigrationConnection(connection, apply)
        : makeRunnerExecutor({ functionArn: transport.functionArn, target: connection }).pipe(
            Effect.flatMap(apply),
          ),
  });
});

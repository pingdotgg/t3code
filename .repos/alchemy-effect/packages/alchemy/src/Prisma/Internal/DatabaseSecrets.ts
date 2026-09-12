import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  extractConnectionSecrets,
  isNotFound,
  type PrismaManagementClient,
} from "../Client.ts";
import { parsePostgresOrigin, type PostgresOrigin } from "../PostgresOrigin.ts";
import type { Database, PrismaSecretConnection } from "../Types.ts";

export const hasCanonicalConnectionSecrets = (
  secrets: PrismaSecretConnection,
) =>
  secrets.directConnectionString !== undefined ||
  secrets.pooledConnectionString !== undefined ||
  secrets.accelerateConnectionString !== undefined;

/**
 * Derive the conventional `databaseUrl` and parsed `origin` / `pooledOrigin`
 * attributes from a connection's secret strings. Shared between the live
 * Connection provider and the dev provider so local `@prisma/dev`
 * connections materialize the same shape.
 */
export const deriveConnectionAttrs = (secrets: {
  directConnectionString?: Redacted.Redacted<string> | undefined;
  pooledConnectionString?: Redacted.Redacted<string> | undefined;
  accelerateConnectionString?: Redacted.Redacted<string> | undefined;
}): {
  databaseUrl: Redacted.Redacted<string> | undefined;
  origin: PostgresOrigin | undefined;
  pooledOrigin: PostgresOrigin | undefined;
} => ({
  databaseUrl:
    secrets.pooledConnectionString ??
    secrets.directConnectionString ??
    secrets.accelerateConnectionString,
  origin: secrets.directConnectionString
    ? parsePostgresOrigin(Redacted.value(secrets.directConnectionString))
    : undefined,
  pooledOrigin: secrets.pooledConnectionString
    ? parsePostgresOrigin(Redacted.value(secrets.pooledConnectionString))
    : undefined,
});

export const mergeConnectionSecrets = (
  preferred: PrismaSecretConnection,
  fallback: PrismaSecretConnection,
): PrismaSecretConnection => ({
  directConnectionString:
    preferred.directConnectionString ?? fallback.directConnectionString,
  pooledConnectionString:
    preferred.pooledConnectionString ?? fallback.pooledConnectionString,
  accelerateConnectionString:
    preferred.accelerateConnectionString ?? fallback.accelerateConnectionString,
  host: preferred.host ?? fallback.host,
  user: preferred.user ?? fallback.user,
  password: preferred.password ?? fallback.password,
});

class DatabaseCredentialsNotReady extends Error {}

const databaseCredentialsSchedule = Schedule.max([
  Schedule.exponential("250 millis"),
  Schedule.recurs(6),
]);

const waitForRotatableDatabase = (
  client: PrismaManagementClient,
  database: Database,
) =>
  client.getDatabase(database.id).pipe(
    Effect.catchIf(isNotFound, () =>
      Effect.fail(
        new DatabaseCredentialsNotReady(
          `Prisma database '${database.name}' (${database.id}) is not visible yet while waiting to recover its credentials.`,
        ),
      ),
    ),
    Effect.flatMap((observed) =>
      observed.status === "failure"
        ? Effect.fail(
            new Error(
              `Prisma database '${observed.name}' (${observed.id}) entered terminal status 'failure' before credentials could be recovered.`,
            ),
          )
        : observed.status === "ready" && observed.defaultConnectionId !== null
          ? Effect.succeed(observed)
          : Effect.fail(
              new DatabaseCredentialsNotReady(
                `Prisma database '${observed.name}' (${observed.id}) is '${observed.status}' with defaultConnectionId '${observed.defaultConnectionId ?? "null"}'; waiting for a ready default connection before recovering credentials.`,
              ),
            ),
    ),
    Effect.retry({
      while: (error) => error instanceof DatabaseCredentialsNotReady,
      schedule: databaseCredentialsSchedule,
    }),
  );

/**
 * Recover one-time database credentials after create success but before state
 * persistence. Prisma's ordinary database reads omit those values, so rotate
 * the observed default connection once when no canonical URL is available.
 */
export const recoverDatabaseConnectionSecrets = Effect.fn(function* (
  client: PrismaManagementClient,
  initialDatabase: Database,
  known: PrismaSecretConnection,
) {
  if (initialDatabase.status === "failure") {
    return yield* Effect.fail(
      new Error(
        `Prisma database '${initialDatabase.name}' (${initialDatabase.id}) is in terminal status 'failure'; credentials cannot be recovered.`,
      ),
    );
  }
  let database = initialDatabase;
  const observedConnection =
    database.connections.find(
      (connection) => connection.id === database.defaultConnectionId,
    ) ?? database.connections[0];
  const available = mergeConnectionSecrets(
    extractConnectionSecrets(observedConnection),
    known,
  );
  if (hasCanonicalConnectionSecrets(available)) {
    return { database, secrets: available };
  }

  if (database.status !== "ready" || database.defaultConnectionId === null) {
    database = yield* waitForRotatableDatabase(client, database);
  }

  const refreshedConnection =
    database.connections.find(
      (connection) => connection.id === database.defaultConnectionId,
    ) ?? database.connections[0];
  const refreshed = mergeConnectionSecrets(
    extractConnectionSecrets(refreshedConnection),
    available,
  );
  if (hasCanonicalConnectionSecrets(refreshed)) {
    return { database, secrets: refreshed };
  }

  const connectionId = database.defaultConnectionId;
  if (connectionId === null) {
    return yield* Effect.fail(
      new DatabaseCredentialsNotReady(
        `Prisma database '${database.name}' (${database.id}) was reported ready without a defaultConnectionId after the credential recovery wait.`,
      ),
    );
  }
  const rotated = yield* client.rotateConnection(connectionId);
  if (rotated.id !== connectionId || rotated.database.id !== database.id) {
    return yield* Effect.fail(
      new Error(
        `Prisma rotated connection '${rotated.id}' for database '${rotated.database.id}', but connection '${connectionId}' belonging to database '${database.id}' was requested. Refusing to persist mismatched credentials.`,
      ),
    );
  }
  const recovered = mergeConnectionSecrets(
    extractConnectionSecrets(rotated),
    refreshed,
  );
  if (!hasCanonicalConnectionSecrets(recovered)) {
    return yield* Effect.fail(
      new Error(
        `Prisma rotated default connection '${connectionId}' for database '${database.id}' without returning a canonical connection URL. Retry after database provisioning completes.`,
      ),
    );
  }
  return { database, secrets: recovered };
});

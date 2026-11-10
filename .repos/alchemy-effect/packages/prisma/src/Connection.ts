import { Retry } from "@distilled.cloud/prisma";
import {
  type GetConnectionsResponse,
  deleteConnection,
  getConnections,
  getConnection,
  getDatabaseConnections,
  createConnection,
  createConnectionRotate,
} from "@distilled.cloud/prisma/management";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { extractConnectionSecrets } from "./Client.ts";
import type { Database } from "./Database.ts";
import {
  deriveConnectionAttrs,
  hasCanonicalConnectionSecrets,
} from "./internal/DatabaseSecrets.ts";
import {
  DEV_TIMESTAMP,
  attrOrNullableString,
  attrOrRedactedString,
  attrOrString,
  devId,
  devProvider,
} from "./internal/DevStub.ts";
import { physicalInstanceName } from "./internal/EnvName.ts";
import type { ObservedConnectionRecord } from "./internal/Observed.ts";
import { PrismaPaginationError } from "./internal/Pagination.ts";
import {
  concreteIdOf,
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveDatabaseId,
  unresolvedDatabaseIdOf,
} from "./internal/Refs.ts";
import type { PostgresOrigin } from "./PostgresOrigin.ts";
import type { Providers } from "./Providers.ts";
import type { PrismaSecretConnection } from "./Types.ts";

export class ConnectionConflict extends Data.TaggedError("ConnectionConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ConnectionUnexpectedResponse extends Data.TaggedError("ConnectionUnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ConnectionProps {
  /**
   * Database ID or `database.databaseId` output this connection belongs to.
   */
  database: string | Database;
  /**
   * Human-readable connection name prefix. Alchemy appends the resource
   * instance identity because Prisma permits duplicate connection names and
   * exposes no ownership tags.
   *
   * @default the resource's logical ID
   */
  name?: string;
  /**
   * Rotate credentials when this value changes from `false` to `true` while
   * keeping the connection ID. Prisma revokes the previous credentials on a
   * best-effort basis. Deploy `false` before changing back to `true` for a
   * later rotation.
   *
   * @default false
   */
  rotate?: boolean;
}

export interface Connection extends Resource<
  "Prisma.Connection",
  ConnectionProps,
  {
    /**
     * Prisma connection/API key ID.
     */
    connectionId: string;
    /**
     * Connection display name.
     */
    connectionName: string;
    /**
     * Database ID this connection belongs to.
     */
    databaseId: string;
    /**
     * Connection kind returned by Prisma.
     */
    kind: "postgres" | "accelerate";
    /**
     * ISO timestamp when the connection was created.
     */
    createdAt: string;
    /**
     * Direct Postgres connection string, redacted in state.
     */
    directConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Pooled Postgres connection string, redacted in state.
     */
    pooledConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Accelerate connection string, redacted in state.
     */
    accelerateConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Direct database host, when returned by Prisma.
     */
    host: string | null | undefined;
    /**
     * Direct database username, when returned by Prisma.
     */
    user: string | null | undefined;
    /**
     * Direct database password, redacted in state.
     */
    password: Redacted.Redacted<string> | undefined;
    /**
     * Conventional application database URL, redacted in state.
     *
     * Resolves to the pooled Postgres URL first, then direct Postgres, then
     * Accelerate — the serverless-safe default for application traffic.
     */
    databaseUrl: Redacted.Redacted<string> | undefined;
    /**
     * Parsed direct connection components ready to feed into a Postgres
     * origin — e.g. `Cloudflare.Hyperdrive`'s `origin` prop. Points at the
     * direct (non-pooled) endpoint, which is the recommended target when
     * fronting Prisma Postgres with another pooler like Hyperdrive.
     */
    origin: PostgresOrigin | undefined;
    /**
     * Parsed pooled connection components. Useful as a Hyperdrive `dev`
     * origin when local workers bypass Hyperdrive and connect directly.
     */
    pooledOrigin: PostgresOrigin | undefined;
  },
  never,
  Providers
> {}

/**
 * A Prisma database connection/API key.
 *
 * Prisma returns connection credentials only when it creates or rotates a
 * connection. Alchemy stores those outputs as `Redacted` values. Changing the
 * database or name replaces the connection; changing `rotate` from `false` to
 * `true` keeps the connection ID and requests fresh credentials.
 *
 * ### Creating a Connection
 * **Example:** Application connection
 * ```typescript
 * const connection = yield* Prisma.Connection("api", {
 *   database: database.databaseId,
 * });
 * ```
 *
 * ### Binding to Platforms
 * **Example:** Pass database URLs to Compute env
 * ```typescript
 * const connection = yield* Prisma.Connection("api", {
 *   database,
 * });
 *
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   env: {
 *     DATABASE_URL: connection.databaseUrl,
 *     DIRECT_URL: connection.directConnectionString,
 *   },
 * });
 * ```
 *
 * **Example:** Use a connection inside an Effect-native Compute app
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, appName: "api", main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connect(connection);
 *     const sql = yield* SQL.Postgres({ url: db.databaseUrl });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const users = yield* sql`SELECT * FROM users`;
 *         return yield* HttpServerResponse.json(users);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectBinding)),
 * );
 * ```
 *
 * **Example:** Use a connection inside an Effect-native Lambda function
 * ```typescript
 * export default AWS.Lambda.Function(
 *   "api",
 *   { main: import.meta.filename, functionUrl: true },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connect(connection);
 *     const sql = yield* SQL.Postgres({ url: db.databaseUrl });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const users = yield* sql`SELECT * FROM users`;
 *         return yield* HttpServerResponse.json(users);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectBinding)),
 * );
 * ```
 *
 * **Example:** Use a connection inside an Effect-native Cloudflare Worker
 * ```typescript
 * export default Cloudflare.Worker(
 *   "api",
 *   { main: import.meta.filename, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connect(connection);
 *     const sql = yield* SQL.Postgres({ url: db.databaseUrl });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* sql`SELECT 1 AS ok`;
 *         return yield* HttpServerResponse.json(result);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectBinding)),
 * );
 * ```
 *
 * ### Rotating Credentials
 * **Example:** Request one rotation
 * ```typescript
 * const connection = yield* Prisma.Connection("api", {
 *   database,
 *   rotate: true,
 * });
 * ```
 *
 * ### Connecting over Hyperdrive
 * **Example:** Front Prisma Postgres with Cloudflare Hyperdrive
 * ```typescript
 * const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("api-hd", {
 *   origin: connection.origin.as<Prisma.PostgresOrigin>(),
 * });
 *
 * export default Cloudflare.Worker(
 *   "api",
 *   { main: import.meta.filename, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const hd = yield* Cloudflare.Hyperdrive.Connect(hyperdrive);
 *     const sql = yield* SQL.Postgres({ url: hd.connectionString });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const users = yield* sql`SELECT * FROM users`;
 *         return yield* HttpServerResponse.json(users);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
 * );
 * ```
 *
 * @resource
 * @product Postgres
 */
export const Connection = Resource<Connection>("Prisma.Connection");

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listDatabaseConnections = (databaseId: string) =>
  Effect.gen(function* () {
    const connections: GetConnectionsResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getDatabaseConnections(
        cursor === undefined ? { databaseId, limit: 100 } : { databaseId, limit: 100, cursor },
      );
      connections.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getDatabaseConnections: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return connections;
  });

const listAllConnections = () =>
  Effect.gen(function* () {
    const connections: GetConnectionsResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getConnections(cursor === undefined ? {} : { cursor });
      connections.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getConnections: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return connections;
  });

const findConnection = (
  databaseId: string,
  predicate: (connection: ObservedConnectionRecord) => boolean,
) =>
  listDatabaseConnections(databaseId).pipe(
    Effect.map((connections) => connections.filter(predicate)),
  );

class AmbiguousPrismaConnectionError extends Data.TaggedError("AmbiguousPrismaConnectionError")<{
  readonly databaseId: string;
  readonly connectionName: string;
  readonly count: number;
}> {
  override get message() {
    return `Prisma database '${this.databaseId}' has ${this.count} connections named '${this.connectionName}'; use a unique connection name before importing it into Alchemy`;
  }
}

class InvalidPrismaConnectionNameError extends Data.TaggedError(
  "InvalidPrismaConnectionNameError",
) {
  override get message() {
    return "Prisma connection name must contain at least one non-space character";
  }
}

const validateConnectionName = (name: string) => {
  const trimmed = name.trim();
  return trimmed.length === 0
    ? Effect.fail(new InvalidPrismaConnectionNameError())
    : Effect.succeed(trimmed);
};

const uniqueConnection = (
  databaseId: string,
  description: string,
  predicate: (connection: ObservedConnectionRecord) => boolean,
) =>
  findConnection(databaseId, predicate).pipe(
    Effect.flatMap((connections) =>
      connections.length <= 1
        ? Effect.succeed(connections[0])
        : Effect.fail(
            new AmbiguousPrismaConnectionError({
              databaseId,
              connectionName: description,
              count: connections.length,
            }),
          ),
    ),
  );

class GeneratedConnectionNotVisible extends Data.TaggedError("GeneratedConnectionNotVisible")<{
  readonly message: string;
}> {}

const generatedConnectionRecoverySchedule = Schedule.max([
  Schedule.exponential("250 millis"),
  Schedule.recurs(6),
]);

const recoverGeneratedConnectionAfterConflict = (databaseId: string, expectedName: string) =>
  uniqueConnection(databaseId, expectedName, (candidate) => candidate.name === expectedName).pipe(
    Effect.flatMap((connection) =>
      connection
        ? Effect.succeed(connection)
        : Effect.fail(
            new GeneratedConnectionNotVisible({
              message: `Generated Prisma connection '${expectedName}' is not visible yet.`,
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof GeneratedConnectionNotVisible,
      schedule: generatedConnectionRecoverySchedule,
    }),
  );

const physicalConnectionPrefix = (name: string) => `${name.trim().slice(0, 52)}-`;

const isGeneratedPhysicalConnectionName = (physicalName: string, logicalName: string) => {
  const prefix = physicalConnectionPrefix(logicalName);
  return (
    physicalName.startsWith(prefix) && /^[0-9a-f]{12}$/i.test(physicalName.slice(prefix.length))
  );
};

const isAdoptablePhysicalConnectionName = (physicalName: string, logicalName: string) =>
  physicalName === logicalName.trim() ||
  isGeneratedPhysicalConnectionName(physicalName, logicalName);

const attrsFrom = (
  connection: ObservedConnectionRecord,
  secrets: PrismaSecretConnection,
): Connection["Attributes"] => ({
  connectionId: connection.id,
  connectionName: connection.name,
  databaseId: connection.database.id,
  kind: connection.kind,
  createdAt: connection.createdAt,
  directConnectionString: secrets.directConnectionString,
  pooledConnectionString: secrets.pooledConnectionString,
  accelerateConnectionString: secrets.accelerateConnectionString,
  host: secrets.host,
  user: secrets.user,
  password: secrets.password,
  ...deriveConnectionAttrs(secrets),
});

const ProviderLive = () =>
  Provider.effect(
    Connection,
    Effect.gen(function* () {
      return {
        stables: ["connectionId"],
        list: () =>
          listAllConnections().pipe(
            Effect.map((connections) => connections.map((c) => attrsFrom(c, {}))),
          ),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.connectionId)) {
            return { action: "update" } as const;
          }
          const oldDatabaseId = output?.databaseId ?? unresolvedDatabaseIdOf(olds.database);
          const newDatabaseId = isResolved(news.database)
            ? unresolvedDatabaseIdOf(news.database)
            : undefined;
          const resolvedName = isResolved(news.name)
            ? yield* validateConnectionName(news.name ?? id)
            : undefined;
          const nameChanged =
            resolvedName !== undefined && resolvedName !== (olds.name ?? id).trim();
          if (concreteIdsChanged(oldDatabaseId, newDatabaseId) || nameChanged) {
            return { action: "replace" } as const;
          }
          if (!isResolved(news.rotate)) return undefined;
          if ((news.rotate ?? false) !== (olds.rotate ?? false)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, instanceId, output, olds }) {
          const connectionId = isPrismaDevId(output?.connectionId)
            ? undefined
            : output?.connectionId;
          if (connectionId && output) {
            const connection = yield* getConnection({
              id: connectionId,
            }).pipe(
              Effect.map((response) => response.data),
              Effect.catchTag("NotFound", () => Effect.undefined),
            );
            if (!connection) return undefined;
            if (
              connection.database.id !== output.databaseId ||
              connection.name !== output.connectionName
            ) {
              return yield* new ConnectionConflict({
                message: `Prisma connection '${connection.id}' no longer matches persisted database '${output.databaseId}' and name '${output.connectionName}'. Refusing to refresh a mismatched connection.`,
              });
            }
            const observed = extractConnectionSecrets(connection);
            return attrsFrom(connection, {
              directConnectionString: output?.directConnectionString,
              pooledConnectionString: output?.pooledConnectionString,
              accelerateConnectionString: output?.accelerateConnectionString,
              host: observed.host,
              user: output?.user,
              password: output?.password,
            });
          }

          const databaseId = unresolvedDatabaseIdOf(olds.database);
          if (!databaseId) return undefined;
          const name = yield* validateConnectionName(olds.name ?? id);
          const expectedName = physicalInstanceName(name, instanceId);
          const owned = yield* uniqueConnection(
            databaseId,
            expectedName,
            (connection) => connection.name === expectedName,
          );
          if (owned) return attrsFrom(owned, {});

          const prefix = physicalConnectionPrefix(name);
          const generated = yield* uniqueConnection(
            databaseId,
            `${prefix}<instance-id>`,
            (connection) =>
              connection.name !== expectedName &&
              isGeneratedPhysicalConnectionName(connection.name, name),
          );
          const connection =
            generated ??
            (yield* uniqueConnection(databaseId, name, (connection) => connection.name === name));
          if (!connection) return undefined;
          return Unowned(attrsFrom(connection, {}));
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          const databaseId = yield* resolveDatabaseId(news.database);
          const name = yield* validateConnectionName(news.name ?? id);
          const connectionId = concreteIdOf(output?.connectionId);
          let connection: ObservedConnectionRecord | undefined = connectionId
            ? yield* getConnection({ id: connectionId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;

          const expectedName = physicalInstanceName(name, instanceId);
          const physicalName = connectionId && output ? output.connectionName : expectedName;
          if (connectionId && !isAdoptablePhysicalConnectionName(physicalName, name)) {
            return yield* new ConnectionConflict({
              message: `Persisted Prisma connection '${connectionId}' has physical name '${physicalName}', which does not match requested logical name '${name}'. Refusing to adopt or persist a mismatched connection.`,
            });
          }
          if (
            connection &&
            (connection.database.id !== databaseId || connection.name !== physicalName)
          ) {
            return yield* new ConnectionConflict({
              message: `Prisma connection '${connection.id}' resolves to database '${connection.database.id}' with name '${connection.name}', not requested database '${databaseId}' and physical name '${physicalName}'. Refusing to rotate or persist mismatched identity; replace the connection instead.`,
            });
          }

          if (!connection && !connectionId) {
            connection = yield* uniqueConnection(
              databaseId,
              expectedName,
              (candidate) => candidate.name === expectedName,
            );
          }

          let secrets: PrismaSecretConnection = connection
            ? extractConnectionSecrets(connection)
            : {};
          if (!connection) {
            const create = createConnection({
              databaseId,
              name: physicalName,
            }).pipe(
              // A replayed create would mint a second connection; the retry
              // policy cannot see the request, so opt out explicitly.
              Retry.none,
              Effect.map((response) => response.data),
            );
            connection = yield* physicalName === expectedName
              ? create.pipe(
                  Effect.catchTag("Conflict", () =>
                    recoverGeneratedConnectionAfterConflict(databaseId, expectedName),
                  ),
                )
              : create;
            secrets = extractConnectionSecrets(connection);
          }
          const missingCanonicalSecrets =
            secrets.directConnectionString === undefined &&
            secrets.pooledConnectionString === undefined &&
            secrets.accelerateConnectionString === undefined &&
            output?.directConnectionString === undefined &&
            output?.pooledConnectionString === undefined &&
            output?.accelerateConnectionString === undefined;
          const recoveringOwnedGeneratedSecrets =
            physicalName === expectedName && missingCanonicalSecrets;
          if (recoveringOwnedGeneratedSecrets || (news.rotate === true && olds?.rotate !== true)) {
            const rotated = yield* createConnectionRotate({
              id: connection.id,
            }).pipe(
              // Rotation mints new credentials; a replay would revoke the
              // ones we just persisted, so opt out of the retry policy.
              Retry.none,
              Effect.map((response) => response.data),
            );
            if (
              rotated.id !== connection.id ||
              rotated.database.id !== databaseId ||
              rotated.name !== physicalName
            ) {
              return yield* new ConnectionUnexpectedResponse({
                message: `Prisma rotated connection '${rotated.id}' for database '${rotated.database.id}' with name '${rotated.name}', but connection '${connection.id}' for database '${databaseId}' with name '${physicalName}' was requested. Refusing to persist mismatched credentials.`,
              });
            }
            connection = rotated;
            secrets = extractConnectionSecrets(rotated);
            if (!hasCanonicalConnectionSecrets(secrets)) {
              return yield* new ConnectionUnexpectedResponse({
                message: `Prisma rotated connection '${connection.id}' for database '${databaseId}' without returning a canonical connection URL. Refusing to persist missing or stale credentials.`,
              });
            }
          }

          return attrsFrom(connection, {
            directConnectionString:
              secrets.directConnectionString ?? output?.directConnectionString,
            pooledConnectionString:
              secrets.pooledConnectionString ?? output?.pooledConnectionString,
            accelerateConnectionString:
              secrets.accelerateConnectionString ?? output?.accelerateConnectionString,
            host: secrets.host ?? output?.host,
            user: secrets.user ?? output?.user,
            password: secrets.password ?? output?.password,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.connectionId)) return;
          const connection = yield* getConnection({
            id: output.connectionId,
          }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
          if (!connection) return;
          if (
            connection.database.id !== output.databaseId ||
            connection.name !== output.connectionName
          ) {
            return yield* new ConnectionConflict({
              message: `Prisma connection '${connection.id}' no longer matches persisted database '${output.databaseId}' and name '${output.connectionName}'. Refusing to delete a mismatched connection.`,
            });
          }
          yield* deleteConnection({ id: connection.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(Connection, ["connectionId"], ({ id, news }) => {
    const secrets = {
      directConnectionString: attrOrRedactedString(news.database, "directConnectionString"),
      pooledConnectionString: attrOrRedactedString(news.database, "pooledConnectionString"),
      accelerateConnectionString: attrOrRedactedString(news.database, "accelerateConnectionString"),
    };
    return {
      connectionId: devId("connection", id),
      connectionName: news.name ?? id,
      databaseId: attrOrString(news.database, "databaseId"),
      kind: "postgres",
      createdAt: DEV_TIMESTAMP,
      ...secrets,
      host: attrOrNullableString(news.database, "host"),
      user: attrOrNullableString(news.database, "user"),
      password: attrOrRedactedString(news.database, "password"),
      ...deriveConnectionAttrs(secrets),
    };
  });

export const ConnectionProvider = () =>
  ProviderLayer.dual(Connection, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });

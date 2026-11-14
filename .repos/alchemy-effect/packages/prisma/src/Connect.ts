import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Connection } from "./Connection.ts";
import { envName } from "./internal/EnvName.ts";

/**
 * The typed runtime client returned by {@link Connect}.
 */
export interface ConnectClient {
  /**
   * Conventional application database URL, redacted.
   *
   * Resolves to the pooled Postgres URL first, then direct Postgres, then
   * Accelerate — the serverless-safe default for application traffic. Dies
   * with a descriptive defect when the connection carries no URL at all.
   *
   * Feed it straight into `SQL.Postgres` / `Drizzle.Postgres`:
   *
   * ```typescript
   * const db = yield* Prisma.Connect(connection);
   * const sql = yield* SQL.Postgres({ url: db.databaseUrl });
   * ```
   */
  databaseUrl: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
  /**
   * Prisma connection/API key ID.
   */
  connectionId: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Database ID this connection belongs to.
   */
  databaseId: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Direct Postgres connection string, when available.
   */
  directConnectionString: Effect.Effect<
    Redacted.Redacted<string> | undefined,
    never,
    RuntimeContext
  >;
  /**
   * Pooled Prisma Postgres connection string, when available.
   */
  pooledConnectionString: Effect.Effect<
    Redacted.Redacted<string> | undefined,
    never,
    RuntimeContext
  >;
  /**
   * Accelerate connection string, when available.
   */
  accelerateConnectionString: Effect.Effect<
    Redacted.Redacted<string> | undefined,
    never,
    RuntimeContext
  >;
  /**
   * Direct database host, when available.
   */
  host: Effect.Effect<string | null | undefined, never, RuntimeContext>;
  /**
   * Direct database user, when available.
   */
  user: Effect.Effect<string | null | undefined, never, RuntimeContext>;
  /**
   * Direct database password, when available.
   */
  password: Effect.Effect<Redacted.Redacted<string> | undefined, never, RuntimeContext>;
}

/**
 * Bind a {@link Connection} to any Function or Worker host (a Prisma
 * Compute app, AWS Lambda Function, Cloudflare Worker or Container, …) and
 * obtain the typed runtime client.
 *
 * `Connect` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Prisma.Connect(connection)`.
 *
 * Provide `Prisma.ConnectBinding` on the host implementation so Alchemy can
 * register the deploy-time binding and resolve the client at runtime.
 *
 * ### Binding a Connection
 * **Example:** Use a connection inside Prisma Compute
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connect(connection);
 *     const sql = yield* SQL.Postgres({ url: db.databaseUrl });
 *
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
 * **Example:** Use a connection inside a Cloudflare Container
 * ```typescript
 * export default Api.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connect(connection);
 *     const sql = yield* SQL.Postgres({ url: db.databaseUrl });
 *
 *     return Api.of({
 *       fetch: Effect.gen(function* () {
 *         const users = yield* sql`SELECT * FROM users`;
 *         return yield* HttpServerResponse.json(users);
 *       }),
 *     });
 *   }).pipe(Effect.provide(Prisma.ConnectBinding)),
 * );
 * ```
 *
 * A container is a real process with no workerd bindings, so the connection
 * travels as plain environment variables — the same channel Prisma Compute
 * and Lambda use. Start the container with
 * `api.start({ enableInternet: true })` so it can reach the database. (Hyperdrive, by contrast, is a workerd binding and is
 * unavailable inside a container.)
 *
 * @binding
 * @product Postgres
 */
export interface Connect extends Binding.Service<
  Connect,
  "Prisma.Connect",
  (connection: Connection) => Effect.Effect<ConnectClient>
> {}

export const Connect = Binding.Service<Connect>("Prisma.Connect");

export interface ConnectEnvKeys {
  connectionId: string;
  databaseId: string;
  directConnectionString: string;
  pooledConnectionString: string;
  accelerateConnectionString: string;
  host: string;
  user: string;
  password: string;
}

/**
 * Derive the env var names {@link Connect} uses to carry a Connection's
 * outputs into the host runtime.
 */
export const connectEnvKeys = (
  connection: Pick<Connection, "FQN" | "LogicalId">,
): ConnectEnvKeys => {
  const name = connection.FQN === connection.LogicalId ? connection.LogicalId : connection.FQN;
  const prefix = `PRISMA_${envName(name)}`;
  return {
    connectionId: `${prefix}_CONNECTION_ID`,
    databaseId: `${prefix}_DATABASE_ID`,
    directConnectionString: `${prefix}_DIRECT_CONNECTION_STRING`,
    pooledConnectionString: `${prefix}_POOLED_CONNECTION_STRING`,
    accelerateConnectionString: `${prefix}_ACCELERATE_CONNECTION_STRING`,
    host: `${prefix}_HOST`,
    user: `${prefix}_USER`,
    password: `${prefix}_PASSWORD`,
  };
};

// Compute env sync omits undefined and treats null as deletion. Connection
// bindings need both values to round-trip into the typed runtime client.
const ENCODED_CONNECTION_PREFIX = "__ALCHEMY_PRISMA_CONNECTION_VALUE__:";

type EncodedConnectionValue =
  | { readonly kind: "undefined" }
  | { readonly kind: "null" }
  | { readonly kind: "value"; readonly value: string };

const encodeConnectionValue = (value: EncodedConnectionValue) =>
  `${ENCODED_CONNECTION_PREFIX}${JSON.stringify(value)}`;

const escapePrefixedValue = <A extends string | Redacted.Redacted<string>>(
  value: A,
): A | string | Redacted.Redacted<string> => {
  const raw = typeof value === "string" ? value : String(Redacted.value(value));
  if (!raw.startsWith(ENCODED_CONNECTION_PREFIX)) return value;
  const encoded = encodeConnectionValue({ kind: "value", value: raw });
  return Redacted.isRedacted(value) ? Redacted.make(encoded) : encoded;
};

const encodeOptionalValue = <A extends string | Redacted.Redacted<string>>(
  output: Output.Output<A | null | undefined>,
): Output.Output<A | string | Redacted.Redacted<string>> =>
  output.pipe(
    Output.map((value) =>
      value === undefined
        ? encodeConnectionValue({ kind: "undefined" })
        : value === null
          ? encodeConnectionValue({ kind: "null" })
          : escapePrefixedValue(value),
    ),
  ) as Output.Output<A | string | Redacted.Redacted<string>>;

const encodedConnectEnv = (connection: Connection) => ({
  connectionId: connection.connectionId,
  databaseId: connection.databaseId,
  directConnectionString: encodeOptionalValue(connection.directConnectionString),
  pooledConnectionString: encodeOptionalValue(connection.pooledConnectionString),
  accelerateConnectionString: encodeOptionalValue(connection.accelerateConnectionString),
  host: encodeOptionalValue(connection.host),
  user: encodeOptionalValue(connection.user),
  password: encodeOptionalValue(connection.password),
});

const redactedToString = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined => (Redacted.isRedacted(value) ? Redacted.value(value) : value);

const decodeConnectionValue = (
  value: Redacted.Redacted<string> | string,
): string | null | undefined => {
  const raw = redactedToString(value);
  if (raw === undefined || !raw.startsWith(ENCODED_CONNECTION_PREFIX)) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw.slice(ENCODED_CONNECTION_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
      return raw;
    }
    if (parsed.kind === "undefined") return undefined;
    if (parsed.kind === "null") return null;
    if (parsed.kind === "value" && typeof parsed.value === "string") {
      return parsed.value;
    }
    return raw;
  } catch {
    return raw;
  }
};

const optionalString = (value: Redacted.Redacted<string> | string): string | undefined =>
  decodeConnectionValue(value) ?? undefined;

const optionalRedacted = (
  value: Redacted.Redacted<string> | string,
): Redacted.Redacted<string> | undefined => {
  const decoded = optionalString(value);
  return decoded === undefined ? undefined : Redacted.make(decoded);
};

const nullableString = (value: Redacted.Redacted<string> | string): string | null | undefined =>
  decodeConnectionValue(value);

/**
 * Implementation layer for {@link Connect}. Provide it on the host
 * Function/Worker Effect:
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const db = yield* Prisma.Connect(connection);
 *   // ...
 * }).pipe(Effect.provide(Prisma.ConnectBinding))
 * ```
 */
export const ConnectBinding = Layer.effect(
  Connect,
  Effect.gen(function* () {
    return Effect.fn(function* (connection: Connection) {
      // Carried through the host's RuntimeContext: env vars on Prisma
      // Compute, Lambda and Containers, text bindings on Workers. Any
      // Platform host works.
      const runtime = yield* CurrentRuntimeContext;
      if (!runtime) {
        return yield* Effect.die(
          new Error("Prisma.Connect must be bound while initializing a Function or Worker"),
        );
      }
      // Records the output on the host at deploy; the returned Effect reads
      // and decodes it at runtime.
      const bind = <A, B>(key: string, output: Output.Output<A>, decode: (value: A) => B) =>
        output
          .bind(key)
          .pipe(Effect.provideService(RuntimeContext, runtime), Effect.map(Effect.map(decode)));
      const keys = connectEnvKeys(connection);
      const env = encodedConnectEnv(connection);
      const directConnectionString = yield* bind(
        keys.directConnectionString,
        env.directConnectionString,
        optionalRedacted,
      );
      const pooledConnectionString = yield* bind(
        keys.pooledConnectionString,
        env.pooledConnectionString,
        optionalRedacted,
      );
      const accelerateConnectionString = yield* bind(
        keys.accelerateConnectionString,
        env.accelerateConnectionString,
        optionalRedacted,
      );
      const databaseUrl = Effect.all([
        pooledConnectionString,
        directConnectionString,
        accelerateConnectionString,
      ]).pipe(
        Effect.flatMap(([pooled, direct, accelerate]) => {
          const url = pooled ?? direct ?? accelerate;
          return url === undefined
            ? Effect.die(
                new Error(
                  "Prisma connection carries no connection URL (no pooled, direct, or Accelerate endpoint was bound)",
                ),
              )
            : Effect.succeed(url);
        }),
      );
      return {
        databaseUrl,
        connectionId: yield* bind(keys.connectionId, env.connectionId, identity),
        databaseId: yield* bind(keys.databaseId, env.databaseId, identity),
        directConnectionString,
        pooledConnectionString,
        accelerateConnectionString,
        host: yield* bind(keys.host, env.host, nullableString),
        user: yield* bind(keys.user, env.user, nullableString),
        password: yield* bind(keys.password, env.password, optionalRedacted),
      } satisfies ConnectClient;
    });
  }),
);

import * as Redacted from "effect/Redacted";

/**
 * The shape `Cloudflare.Hyperdrive` and other Postgres consumers accept
 * as `origin`. Materialized on `Prisma.Connection` so callers can wire
 * Prisma Postgres into Hyperdrive directly:
 *
 * ```typescript
 * const connection = yield* Prisma.Connection("api", { database, name: "api" });
 * const hd = yield* Cloudflare.Hyperdrive.Connection("api-hd", {
 *   origin: connection.origin.as<Prisma.PostgresOrigin>(),
 * });
 * ```
 */
export type PostgresOrigin = {
  scheme: "postgres" | "postgresql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
};

/**
 * Parse a Postgres connection URI into the structured origin shape. Used to
 * derive `connection.origin` / `connection.pooledOrigin` from the direct and
 * pooled connection strings Prisma returns.
 *
 * Returns `undefined` for non-Postgres URIs (e.g. `prisma://` Accelerate
 * connection strings) and malformed values.
 */
export const parsePostgresOrigin = (
  uri: string,
): PostgresOrigin | undefined => {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return undefined;
  }
  return {
    scheme: url.protocol === "postgresql:" ? "postgresql" : "postgres",
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: Redacted.make(decodeURIComponent(url.password)),
  };
};

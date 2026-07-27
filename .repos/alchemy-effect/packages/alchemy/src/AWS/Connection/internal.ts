import * as Redacted from "effect/Redacted";

/**
 * Connection descriptor shared by every SQL-wire `Connect` binding
 * (RDS/Aurora, DSQL, Redshift, ...). The `url` field is the RFC-3986
 * connection URL — it feeds `Drizzle.Postgres` / a Hyperdrive origin
 * directly, so consumers need zero per-engine glue.
 */
export interface SqlConnectionInfo {
  /** Endpoint hostname. */
  host: string;
  /** Endpoint port. */
  port: number;
  /** Database name, when one was requested. */
  database?: string;
  /** Login user, when the credential strategy resolves one. */
  username?: string;
  /**
   * Login password (or short-lived IAM auth token), when the credential
   * strategy resolves one.
   */
  password?: Redacted.Redacted<string>;
  /** Whether the connection requires TLS. */
  ssl: boolean;
  /**
   * RFC-3986 connection URL — feeds `Drizzle.Postgres` / Hyperdrive
   * origin directly.
   */
  url: Redacted.Redacted<string>;
}

/**
 * Environment variable prefix under which a `Connect` binding publishes a
 * resource's endpoint on the host Function, derived from the service name
 * and the resource's logical ID. A MemoryDB cluster with logical ID
 * `SessionStore` yields `MEMORYDB_SESSIONSTORE` and variables like
 * `MEMORYDB_SESSIONSTORE_HOST` / `MEMORYDB_SESSIONSTORE_PORT`.
 */
export const connectEnvPrefix = (service: string, logicalId: string): string =>
  `${sanitizeEnvSegment(service)}_${sanitizeEnvSegment(logicalId)}`;

const sanitizeEnvSegment = (segment: string): string =>
  segment.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();

export interface SqlConnectionUrlOptions {
  /**
   * URL scheme.
   * @default "postgresql"
   */
  scheme?: string;
  host: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string | Redacted.Redacted<string>;
  /**
   * When `true`, appends `sslmode={sslMode}` to the URL query (the
   * postgres-flavored TLS opt-in that both `postgres.js` and Hyperdrive
   * origins understand).
   */
  ssl?: boolean;
  /**
   * `sslmode` value appended when {@link SqlConnectionUrlOptions.ssl} is
   * `true`. `node-pg`'s URL parser treats `require` as full-verification
   * TLS against Node's trust store — endpoints whose certificates chain to
   * a private CA (RDS/Aurora) must use `no-verify` (TLS on, identity
   * verification off — libpq `require` semantics) unless the CA bundle is
   * provided out-of-band.
   * @default "require"
   */
  sslMode?: "require" | "no-verify";
  /** Extra query parameters to append verbatim. */
  params?: Record<string, string>;
}

/**
 * Format an RFC-3986 SQL connection URL
 * (`scheme://user:pass@host:port/database?sslmode=require`). Username and
 * password are percent-encoded; the result is `Redacted` because it embeds
 * the password.
 */
export const formatSqlConnectionUrl = (
  options: SqlConnectionUrlOptions,
): Redacted.Redacted<string> => {
  const scheme = options.scheme ?? "postgresql";
  const password =
    options.password === undefined
      ? undefined
      : typeof options.password === "string"
        ? options.password
        : Redacted.value(options.password);
  const auth =
    options.username !== undefined
      ? password !== undefined
        ? `${encodeURIComponent(options.username)}:${encodeURIComponent(password)}@`
        : `${encodeURIComponent(options.username)}@`
      : "";
  const port = options.port !== undefined ? `:${options.port}` : "";
  const database =
    options.database !== undefined
      ? `/${encodeURIComponent(options.database)}`
      : "";
  const query = new URLSearchParams(options.params);
  if (options.ssl === true) {
    query.set("sslmode", options.sslMode ?? "require");
  }
  const queryString = query.size > 0 ? `?${query.toString()}` : "";
  return Redacted.make(
    `${scheme}://${auth}${options.host}${port}${database}${queryString}`,
  );
};

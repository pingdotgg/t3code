import * as Redacted from "effect/Redacted";

/**
 * The shape `Cloudflare.Hyperdrive` and other Postgres consumers accept
 * as `origin`. Materialized on `Neon.Project` and `Neon.Branch` so callers
 * can wire databases into Hyperdrive directly:
 *
 * ```typescript
 * const branch = yield* Neon.Branch("preview", { project });
 * const hd = yield* Cloudflare.Hyperdrive("preview-hd", {
 *   origin: branch.origin,
 * });
 * ```
 */
export type PostgresOrigin = {
  scheme: "postgres" | "postgresql" | "mysql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
};

/**
 * Parse a Postgres connection URI into the structured origin shape.
 * Used to derive `branch.origin` / `project.origin` from the API
 * response's `connectionUri`.
 */
export const parsePostgresOrigin = (uri: string): PostgresOrigin => {
  const url = new URL(uri);
  const scheme: PostgresOrigin["scheme"] =
    url.protocol === "postgresql:" ? "postgresql" : "postgres";
  return {
    scheme,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: Redacted.make(decodeURIComponent(url.password)),
  };
};

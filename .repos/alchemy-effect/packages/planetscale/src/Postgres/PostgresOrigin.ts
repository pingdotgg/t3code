import * as Redacted from "effect/Redacted";

/**
 * The shape `Cloudflare.Hyperdrive` and other Postgres consumers accept as an
 * origin. Materialized on `Planetscale.PostgresRole` so callers can wire role
 * credentials into Hyperdrive directly.
 */
export type PostgresOrigin = {
  scheme: "postgres" | "postgresql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
};

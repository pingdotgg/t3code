import * as Redacted from "effect/Redacted";

/**
 * The shape `Cloudflare.Hyperdrive` and other MySQL consumers accept as an
 * origin. Materialized on `Planetscale.MySQLPassword` so callers can wire
 * password credentials into Hyperdrive directly.
 */
export type MySQLOrigin = {
  scheme: "mysql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
};

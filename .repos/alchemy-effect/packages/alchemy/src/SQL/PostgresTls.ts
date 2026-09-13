import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Redacted from "effect/Redacted";

type PgSsl = PgClient.PgPoolConfig["ssl"];

/**
 * `sslmode` values `@effect/sql-pg` (≥ 4.0.0-rc.113, still as of rc.115)
 * refuses unless `ssl` is set explicitly: `sslmode "prefer" is not
 * supported: set ssl explicitly to true or false`. node-postgres treated both
 * as "TLS on" (aliases of `verify-full`), and URLs carry them by default in
 * places — Hyperdrive's local `dev` origin passthrough hands the worker
 * `?sslmode=prefer`, and `prefer` is libpq's own default.
 */
const OPPORTUNISTIC_SSL_MODES: ReadonlySet<string> = new Set([
  "prefer",
  "allow",
]);

/**
 * Resolve the `ssl` option to hand `@effect/sql-pg` for a connection URL.
 *
 * When the caller left `ssl` implicit and the URL's `sslmode` is `prefer` or
 * `allow`, returns `ssl: true` so the connection is TLS-on exactly as it was
 * under node-postgres. Every other input is returned untouched so the URL's
 * `sslmode` keeps driving the decision inside `@effect/sql-pg`.
 *
 * (`@effect/sql-pg` < rc.115 also sent no TLS SNI; that was fixed upstream in
 * Effect-TS/effect#8174, so this helper no longer sets `servername`.)
 */
export const resolveSsl = (
  url: Redacted.Redacted<string>,
  ssl: PgSsl,
): PgSsl => {
  if (ssl !== undefined) return ssl;
  let parsed: URL;
  try {
    parsed = new URL(Redacted.value(url));
  } catch {
    // Let `@effect/sql-pg` report the malformed URL.
    return ssl;
  }
  const sslmode = parsed.searchParams.get("sslmode");
  return sslmode !== null && OPPORTUNISTIC_SSL_MODES.has(sslmode) ? true : ssl;
};

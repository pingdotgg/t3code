/**
 * Firefox cookie extraction.
 *
 * Firefox stores cookies unencrypted in `cookies.sqlite`, so there is no key
 * to fetch and no consent prompt — the file is readable by anything running as
 * the user. That is Mozilla's design choice, not a control being circumvented,
 * which is why this path works identically on macOS, Windows, and Linux while
 * the Chromium one needs a per-platform credential store.
 *
 * @module FirefoxCookies
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { cookieScope, snapshotCookieDatabase, type ImportedCookie } from "./CookieDatabase.ts";

/**
 * `moz_cookies.sameSite` uses 0 = none, 1 = lax, 2 = strict. Unlike Chromium
 * there is no "unspecified" sentinel, but treat anything unrecognised as lax:
 * that is the modern default, and guessing "none" would widen a cookie's scope
 * on import.
 */
const sameSiteFromColumn = (value: number): ImportedCookie["sameSite"] => {
  if (value === 0) return "no_restriction";
  if (value === 2) return "strict";
  return "lax";
};

const CookieRow = Schema.Struct({
  host: Schema.String,
  name: Schema.String,
  value: Schema.String,
  path: Schema.String,
  // Already seconds since the UNIX epoch, unlike Chromium's 1601-based
  // microseconds, so no conversion is needed.
  expiry: Schema.Number,
  isSecure: Schema.Number,
  isHttpOnly: Schema.Number,
  sameSite: Schema.Number,
});
const decodeCookieRows = Schema.decodeUnknownEffect(Schema.Array(CookieRow));

export const readFirefoxCookies = Effect.fn("FirefoxCookies.readFirefoxCookies")(function* (
  cookieDatabasePath: string,
) {
  const snapshotPath = yield* snapshotCookieDatabase(cookieDatabasePath);

  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const raw = yield* sql`
      select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
        from moz_cookies
    `;
    return yield* decodeCookieRows(raw);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath, readonly: true })));

  return rows.map((row) => {
    const secure = row.isSecure === 1;
    const scope = cookieScope(row.host, row.path, secure);
    return {
      url: scope.url,
      name: row.name,
      value: row.value,
      domain: scope.domain,
      path: row.path,
      secure,
      httpOnly: row.isHttpOnly === 1,
      expirationDate: row.expiry > 0 ? row.expiry : undefined,
      sameSite: sameSiteFromColumn(row.sameSite),
    } satisfies ImportedCookie;
  });
});

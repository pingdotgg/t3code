import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { cookieScope, snapshotCookieDatabase, type ImportedCookie } from "./CookieDatabase.ts";

export class FirefoxCookieReadError extends Schema.TaggedError<FirefoxCookieReadError>()(
  "FirefoxCookieReadError",
  {
    cookieDatabasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read Firefox cookies at ${this.cookieDatabasePath}.`;
  }
}

/**
 * Unset is not the same thing as None — None is an explicit opt-in to
 * cross-site use — so it is imported as Electron's `unspecified`, which lets
 * the target browser apply its own default exactly as Firefox did. Anything
 * unrecognised also lands there rather than on `no_restriction`, since guessing
 * "none" would widen a cookie's scope on import.
 */
const SAMESITE_NONE = 0;
const SAMESITE_LAX = 1;
const SAMESITE_STRICT = 2;

/**
 * Schemas 10–14 carried a second column, `rawSameSite`: the value the cookie
 * actually declared, beside a `sameSite` that Firefox had already defaulted to
 * Lax. Reading such a database before Firefox has migrated it must apply the
 * same rule, or an undeclared cookie is imported as an explicit Lax.
 */
const FIREFOX_RAW_SAMESITE_FIRST_SCHEMA = 10;
const FIREFOX_RAW_SAMESITE_LAST_SCHEMA = 14;

const sameSiteFromColumn = (
  value: number | null,
  rawValue: number | null,
): ImportedCookie["sameSite"] => {
  // Schema 9 added the column with no default, so older rows carry NULL.
  if (value === null) return "unspecified";
  if (value === SAMESITE_LAX && rawValue === SAMESITE_NONE) return "unspecified";
  if (value === SAMESITE_NONE) return "no_restriction";
  if (value === SAMESITE_LAX) return "lax";
  if (value === SAMESITE_STRICT) return "strict";
  return "unspecified";
};

const CookieRow = Schema.Struct({
  host: Schema.String,
  name: Schema.String,
  value: Schema.String,
  path: Schema.String,
  expiry: Schema.Number,
  isSecure: Schema.Number,
  isHttpOnly: Schema.Number,
  sameSite: Schema.NullOr(Schema.Number),
  rawSameSite: Schema.NullOr(Schema.Number),
});
const decodeCookieRows = Schema.decodeUnknownEffect(Schema.Array(CookieRow));

/**
 * Firefox schema 16 (Firefox 129) moved `expiry` from seconds to milliseconds
 * — the migration is `UPDATE moz_cookies SET expiry = expiry * 1000`. Electron
 * wants seconds, so the unit is decided by `PRAGMA user_version` rather than
 * assumed: importing a pre-16 profile as milliseconds would expire every cookie
 * at once, and a post-16 one as seconds would keep them for ~1000× too long.
 */
const FIREFOX_EXPIRY_MILLISECONDS_SCHEMA = 16;

const UserVersionRow = Schema.Struct({ user_version: Schema.Number });
const decodeUserVersion = Schema.decodeUnknownEffect(Schema.Array(UserVersionRow));

const expiryToSeconds = (expiry: number, schemaVersion: number): number | undefined => {
  if (expiry <= 0) return undefined;
  return schemaVersion >= FIREFOX_EXPIRY_MILLISECONDS_SCHEMA ? Math.floor(expiry / 1000) : expiry;
};

export const readFirefoxCookies = Effect.fn("FirefoxCookies.readFirefoxCookies")(
  function* (cookieDatabasePath: string) {
    const snapshotPath = yield* snapshotCookieDatabase(cookieDatabasePath);

    const { rows, schemaVersion } = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [versionRow] = yield* decodeUserVersion(yield* sql`pragma user_version`);
      const schemaVersion = versionRow?.user_version ?? 0;
      const hasRawSameSite =
        schemaVersion >= FIREFOX_RAW_SAMESITE_FIRST_SCHEMA &&
        schemaVersion <= FIREFOX_RAW_SAMESITE_LAST_SCHEMA;
      // Firefox isolates cookies per container and per private window via
      // `originAttributes` (`^userContextId=2`, `^privateBrowsingId=1`);
      // Electron has no equivalent, so importing them all would collapse
      // several identities onto one host/name/path and hand the profile an
      // arbitrary container's session.
      const raw = hasRawSameSite
        ? yield* sql`
          select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, rawSameSite
            from moz_cookies
           where originAttributes = ''
        `
        : yield* sql`
          select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite,
                 null as rawSameSite
            from moz_cookies
           where originAttributes = ''
        `;
      return { rows: yield* decodeCookieRows(raw), schemaVersion };
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
        expirationDate: expiryToSeconds(row.expiry, schemaVersion),
        sameSite: sameSiteFromColumn(row.sameSite, row.rawSameSite),
      } satisfies ImportedCookie;
    });
  },
  (effect, cookieDatabasePath) =>
    effect.pipe(
      Effect.mapError((cause) => new FirefoxCookieReadError({ cookieDatabasePath, cause })),
    ),
);

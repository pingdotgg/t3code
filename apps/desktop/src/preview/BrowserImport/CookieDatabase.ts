/**
 * Shared pieces of cookie extraction: the shape both engines produce, and the
 * snapshot every reader takes before touching a live database.
 *
 * @module CookieDatabase
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

/** A cookie in the shape Electron's `session.cookies.set` accepts. */
export interface ImportedCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  /**
   * Set only for domain cookies, which the sources mark with a leading dot.
   * A host-only cookie leaves this undefined: Electron treats any `domain` it
   * is given as marking a domain cookie and re-adds the dot, which would widen
   * the cookie to every subdomain of the host it was scoped to, and rejects
   * `__Host-` cookies, which require it to be absent.
   */
  readonly domain: string | undefined;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Seconds since the UNIX epoch, or undefined for a session cookie. */
  readonly expirationDate: number | undefined;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

/**
 * Cookies recovered from one database and rows that could not be decrypted.
 * The skipped count reaches the user instead of disappearing from a partial
 * import result.
 */
export interface CookieReadResult {
  readonly cookies: ReadonlyArray<ImportedCookie>;
  readonly undecryptable: number;
  /** Distinct hosts of the rows that could not be decrypted. */
  readonly undecryptableHosts: ReadonlyArray<string>;
}

/**
 * The URL and domain Electron should register a stored row under.
 *
 * Both engines mark a domain cookie with a leading dot on the host. Electron
 * matches on a URL, so the dot comes off for that; `domain` is passed through
 * only for domain cookies, because supplying it at all makes Electron treat
 * the cookie as one and re-add the dot — widening a host-only cookie to every
 * subdomain of the host it was scoped to, and rejecting `__Host-` cookies,
 * which require it to be absent.
 */
export const cookieScope = (
  host: string,
  path: string,
  secure: boolean,
): { readonly url: string; readonly domain: string | undefined } => {
  const isDomainCookie = host.startsWith(".");
  const unwrappedHost = bareHost(host);
  const authority =
    unwrappedHost.includes(":") && !(unwrappedHost.startsWith("[") && unwrappedHost.endsWith("]"))
      ? `[${unwrappedHost}]`
      : unwrappedHost;
  return {
    url: `${secure ? "https" : "http"}://${authority}${path}`,
    domain: isDomainCookie ? host : undefined,
  };
};

/** A host without the leading dot both engines put on a domain cookie, for display. */
export const bareHost = (host: string): string => (host.startsWith(".") ? host.slice(1) : host);

/**
 * Creates a transactionally consistent snapshot of a cookie database in a
 * temporary directory and returns the snapshot's path.
 *
 * Both engines keep the file open with WAL while the browser runs, so reading
 * in place can observe a torn write. Copying also guarantees we never open the
 * browser's own file for writing.
 *
 * Scoped: the temporary directory goes away when the caller's scope closes.
 */
export const snapshotCookieDatabase = Effect.fn("CookieDatabase.snapshotCookieDatabase")(function* (
  cookiePath: string,
  tempPrefix = "t3code-cookie-import-",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: tempPrefix });
  const target = path.join(directory, path.basename(cookiePath));
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`VACUUM INTO ${target}`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: cookiePath, readonly: true })));
  return target;
});

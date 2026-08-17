/**
 * Shared pieces of cookie extraction: the shape both engines produce, and the
 * snapshot every reader takes before touching a live database.
 *
 * @module CookieDatabase
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
  readonly sameSite: "no_restriction" | "lax" | "strict";
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
  const bareHost = isDomainCookie ? host.slice(1) : host;
  return {
    url: `${secure ? "https" : "http"}://${bareHost}${path}`,
    domain: isDomainCookie ? host : undefined,
  };
};

/**
 * Copies a cookie database, and its write-ahead sidecars, to a temporary
 * directory before reading, and returns the copy's path.
 *
 * Both engines keep the file open with WAL while the browser runs, so reading
 * in place can observe a torn write. Copying also guarantees we never open the
 * browser's own file for writing.
 *
 * Scoped: the temporary directory goes away when the caller's scope closes.
 */
export const snapshotCookieDatabase = Effect.fn("CookieDatabase.snapshotCookieDatabase")(function* (
  cookiePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-cookie-import-",
  });
  const target = path.join(directory, path.basename(cookiePath));
  yield* fileSystem.copyFile(cookiePath, target);
  // A sidecar only exists while the browser holds the database open, so an
  // absent one is normal. Anything else — a permission error, a partial read
  // — is not: SQLite would then open the snapshot without the write-ahead
  // log and quietly return a cookie set missing its newest transactions.
  yield* Effect.forEach(["-wal", "-shm"], (suffix) =>
    fileSystem.copyFile(`${cookiePath}${suffix}`, `${target}${suffix}`).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
    ),
  );
  return target;
});

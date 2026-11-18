import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export interface ImportedCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  /** Leave host-only cookies undefined; Electron widens any supplied domain and rejects __Host- cookies with one. */
  readonly domain: string | undefined;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate: number | undefined;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface CookieReadResult {
  readonly cookies: ReadonlyArray<ImportedCookie>;
  readonly undecryptable: number;
  readonly undecryptableHosts: ReadonlyArray<string>;
}

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

export const bareHost = (host: string): string => (host.startsWith(".") ? host.slice(1) : host);

const vacuumInto = Effect.fn("CookieDatabase.vacuumInto")(
  function* (_source: string, target: string, _readonly: boolean) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`VACUUM INTO ${target}`;
  },
  (effect, source, _target, readonly) =>
    effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: source, readonly }))),
);

const SQLITE_BUSY = 5;

const isDatabaseLocked = (error: unknown) =>
  SqlError.isSqlError(error) &&
  Predicate.hasProperty(error.reason.cause, "errcode") &&
  error.reason.cause.errcode === SQLITE_BUSY;

/** Cookie writes come in short bursts, so a copy that raced one is retried. */
const LOCKED_COPY_ATTEMPTS = 5;

class LockedCookieDatabaseCopyError extends Schema.TaggedError<LockedCookieDatabaseCopyError>()(
  "LockedCookieDatabaseCopyError",
  { cookiePath: Schema.String },
) {
  override get message(): string {
    return `${this.cookiePath} kept changing while it was copied.`;
  }
}

/**
 * Firefox holds `cookies.sqlite` in exclusive locking mode, so no connection
 * can read it, but its bytes can be copied. The main file and WAL are copied
 * as a pair, and the copy counts only if neither changed meanwhile.
 */
const copyLockedDatabase = Effect.fn("CookieDatabase.copyLockedDatabase")(function* (
  source: string,
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = [source, `${source}-wal`];
  const fingerprint = Effect.forEach(files, (file) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`),
      Effect.orElseSucceed(() => "missing"),
    ),
  ).pipe(Effect.map((parts) => parts.join("|")));
  for (let attempt = 0; attempt < LOCKED_COPY_ATTEMPTS; attempt++) {
    const before = yield* fingerprint;
    let complete = true;
    for (const file of files) {
      const target = path.join(directory, path.basename(file));
      yield* fileSystem.remove(target, { force: true });
      if (!(yield* fileSystem.exists(file))) continue;
      // SQLite deletes the WAL when the browser's last connection closes.
      const copied = yield* fileSystem.copyFile(file, target).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(false),
        ),
      );
      complete &&= copied;
    }
    if (complete && (yield* fingerprint) === before) {
      return path.join(directory, path.basename(source));
    }
  }
  return yield* new LockedCookieDatabaseCopyError({ cookiePath: source });
});

/** Copy before reading to avoid live WAL writes and never open the source browser database for writing. */
export const snapshotCookieDatabase = Effect.fn("CookieDatabase.snapshotCookieDatabase")(function* (
  cookiePath: string,
  tempPrefix = "t3code-cookie-import-",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: tempPrefix });
  const target = path.join(directory, path.basename(cookiePath));
  yield* vacuumInto(cookiePath, target, true).pipe(
    Effect.catchIf(isDatabaseLocked, () =>
      Effect.gen(function* () {
        const copyDirectory = path.join(directory, "locked");
        yield* fileSystem.makeDirectory(copyDirectory);
        const copy = yield* copyLockedDatabase(cookiePath, copyDirectory);
        yield* vacuumInto(copy, target, false);
      }),
    ),
  );
  return target;
});

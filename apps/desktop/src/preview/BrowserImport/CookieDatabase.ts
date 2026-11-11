import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

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

/** Copy before reading to avoid live WAL writes and never open the source browser database for writing. */
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

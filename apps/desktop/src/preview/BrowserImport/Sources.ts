/**
 * Importable browser sources.
 *
 * Each entry pins its own on-disk and keychain coordinates rather than
 * deriving them: Chromium forks do not agree on the convention. Helium, for
 * instance, uses the keychain service "Helium Storage Key" / account "Helium"
 * where Chrome and its closer relatives use "<Name> Safe Storage" / "<Name>".
 *
 * @module BrowserImportSources
 */
import type { BrowserImportSourceId, BrowserImportSourceProfile } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Where a source's files live, resolved once per call rather than read from
 * the ambient process so the registry stays testable.
 */
export interface SourcePaths {
  readonly path: Path.Path;
  readonly home: string;
}

export const sourcePaths = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  return { path, home: environment.HOME ?? environment.USERPROFILE ?? "" } satisfies SourcePaths;
});

export interface BrowserImportSourceDefinition {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  /** Platforms the definition's paths are valid for. */
  readonly platforms: ReadonlyArray<NodeJS.Platform>;
  readonly userDataDirectory: (paths: SourcePaths) => string;
  readonly keychainService: string;
  readonly keychainAccount: string;
}

export const BROWSER_IMPORT_SOURCES: ReadonlyArray<BrowserImportSourceDefinition> = [
  {
    id: "helium",
    name: "Helium",
    platforms: ["darwin"],
    userDataDirectory: ({ path, home }) =>
      path.join(home, "Library", "Application Support", "net.imput.helium"),
    keychainService: "Helium Storage Key",
    keychainAccount: "Helium",
  },
];

export const cookieDatabasePath = (
  definition: BrowserImportSourceDefinition,
  paths: SourcePaths,
  profileDirectory: string,
): string => paths.path.join(definition.userDataDirectory(paths), profileDirectory, "Cookies");

/** Shape of the slice of Chromium's `Local State` that names its profiles. */
const LocalState = Schema.Struct({
  profile: Schema.optional(
    Schema.Struct({
      info_cache: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ name: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});
const decodeLocalState = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalState));

/** A single plain path segment: no separators, no `.`/`..`, not empty. */
const isSafeProfileDirectory = (directory: string): boolean =>
  directory.length > 0 &&
  directory !== "." &&
  directory !== ".." &&
  !/[\\/]/.test(directory) &&
  !directory.includes("\u0000");

const CookieCountRow = Schema.Struct({ count: Schema.Number });
const decodeCookieCount = Schema.decodeUnknownEffect(Schema.Array(CookieCountRow));

/**
 * How many cookies a profile holds, counted without decrypting anything — a
 * bare `COUNT(*)` needs no key. Best effort: a locked, missing or non-Chromium
 * database (Firefox's table is named differently, Safari's is not SQL) yields
 * `undefined` rather than failing the listing.
 */
const countProfileCookies = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  paths: SourcePaths,
  directory: string,
): Effect.fn.Return<number | undefined, never> {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`select count(*) as count from cookies`;
    const [row] = yield* decodeCookieCount(rows);
    return row?.count;
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({
        filename: cookieDatabasePath(definition, paths, directory),
        readonly: true,
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
});

const withCookieCounts = (
  definition: BrowserImportSourceDefinition,
  paths: SourcePaths,
  profiles: ReadonlyArray<BrowserImportSourceProfile>,
) =>
  Effect.forEach(profiles, (profile) =>
    countProfileCookies(definition, paths, profile.directory).pipe(
      Effect.map((cookieCount) =>
        cookieCount === undefined ? profile : { ...profile, cookieCount },
      ),
    ),
  );

/**
 * Profiles the source browser knows about, read from its `Local State`.
 *
 * When that file is missing, unreadable or malformed, the user-data directory
 * is scanned for directories that hold a cookie database. Assuming `Default`
 * instead would report a browser whose cookies live in `Profile 1` as having
 * nothing to import — and it is then left out of the menu entirely.
 */
export const listSourceProfiles = Effect.fn("BrowserImportSources.listSourceProfiles")(function* (
  definition: BrowserImportSourceDefinition,
  paths: SourcePaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const localStatePath = paths.path.join(definition.userDataDirectory(paths), "Local State");

  const root = definition.userDataDirectory(paths);
  const declared = yield* fileSystem.readFileString(localStatePath).pipe(
    Effect.flatMap(decodeLocalState),
    Effect.map((state) => Object.entries(state.profile?.info_cache ?? {})),
    // The keys are directory names from the browser's own metadata file, which
    // is writable by anything running as the user. Anything but a single plain
    // segment is dropped: `..` or a path separator would otherwise be handed
    // to `cookieDatabasePath` and read a database outside the user-data
    // directory.
    Effect.map((entries) => entries.filter(([directory]) => isSafeProfileDirectory(directory))),
    Effect.map((entries) =>
      entries.map(([directory, info]) => ({ directory, name: info.name?.trim() || directory })),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
  );
  if (declared.length > 0) return yield* withCookieCounts(definition, paths, declared);

  // `Local State` is missing, unreadable or malformed. Scanning for
  // directories that hold a cookie database finds the profiles anyway;
  // assuming `Default` would report a browser whose cookies live in
  // `Profile 1` as having nothing to import, and it is then hidden entirely.
  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const candidates = entries.filter(isSafeProfileDirectory);
  const found = yield* Effect.forEach(candidates, (directory) =>
    entryExists(cookieDatabasePath(definition, paths, directory)).pipe(
      Effect.map((exists) => (exists ? { directory, name: directory } : undefined)),
    ),
  );
  return yield* withCookieCounts(
    definition,
    paths,
    found.filter((profile) => profile !== undefined),
  );
});

/**
 * Whether a directory entry exists, without following it or opening it.
 *
 * `stat` resolves symlinks and the locks below deliberately dangle, so
 * `readLink` is the probe that answers for the entry itself.
 */
const entryExists = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(path).pipe(
    Effect.catchCause(() => fileSystem.readLink(path)),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

/** Whether the browser is running, which leaves its cookie DB mid-write. */
export const isSourceRunning = Effect.fn("BrowserImportSources.isSourceRunning")(function* (
  definition: BrowserImportSourceDefinition,
  paths: SourcePaths,
) {
  const lock = paths.path.join(definition.userDataDirectory(paths), "SingletonLock");
  // Chromium writes a `SingletonLock` symlink for as long as an instance holds
  // the profile. Its presence is a far cheaper and more targeted signal than
  // scanning the process table for a name.
  //
  // The link points at `<host>-<pid>`, a target that never exists, and both
  // `stat` and `exists` follow links — so they report every running browser as
  // closed, which would let an import read a live, mid-write database.
  // `readLink` is the one probe that answers for the entry itself.
  return yield* entryExists(lock);
});

/**
 * Whether the source has cookies to import.
 *
 * Keyed off the cookie database rather than the user-data directory, because
 * that directory is not evidence the browser exists: installers for native
 * messaging hosts create an empty one for every Chromium fork they know about,
 * so a machine with only Chrome reports Edge, Brave, Vivaldi, Opera and Arc as
 * present. The database is the thing an import actually needs, so its absence
 * is the honest answer either way.
 *
 * Existence is checked without opening the file, which matters for Safari: TCC
 * permits `stat` on the jar inside its container but refuses a read, so this
 * still sees it and the user gets the Full Disk Access prompt rather than
 * having Safari disappear.
 */
export const isSourceInstalled = Effect.fn("BrowserImportSources.isSourceInstalled")(function* (
  definition: BrowserImportSourceDefinition,
  paths: SourcePaths,
) {
  const profiles = yield* listSourceProfiles(definition, paths);
  const found = yield* Effect.forEach(profiles, (profile) =>
    entryExists(cookieDatabasePath(definition, paths, profile.directory)),
  );
  return found.some(Boolean);
});

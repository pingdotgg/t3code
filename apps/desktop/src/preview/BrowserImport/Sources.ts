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
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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

const DEFAULT_PROFILES: ReadonlyArray<BrowserImportSourceProfile> = [
  { directory: "Default", name: "Default" },
];

/**
 * Profiles the source browser knows about, read from its `Local State`.
 *
 * Falls back to the `Default` directory when that file is unreadable or has no
 * profile cache: a browser that has only ever had one profile is the common
 * case, and failing the whole import over a missing display name would be
 * disproportionate.
 */
export const listSourceProfiles = Effect.fn("BrowserImportSources.listSourceProfiles")(function* (
  definition: BrowserImportSourceDefinition,
  paths: SourcePaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const localStatePath = paths.path.join(definition.userDataDirectory(paths), "Local State");

  const profiles = yield* fileSystem.readFileString(localStatePath).pipe(
    Effect.flatMap(decodeLocalState),
    Effect.map((state) => Object.entries(state.profile?.info_cache ?? {})),
    Effect.map((entries) =>
      entries.map(([directory, info]) => ({ directory, name: info.name?.trim() || directory })),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
  );

  return profiles.length === 0 ? DEFAULT_PROFILES : profiles;
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

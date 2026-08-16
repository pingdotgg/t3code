/**
 * Importable browser sources.
 *
 * Two engines are modelled. Chromium-family browsers keep cookies in an
 * encrypted SQLite database whose key lives in an OS credential store; Firefox
 * keeps them in plain SQLite with no key at all, so it needs no keychain and
 * works the same on every platform.
 *
 * Each entry pins its own paths and keychain coordinates rather than deriving
 * them, because the forks do not agree. Helium uses the keychain service
 * "Helium Storage Key" / account "Helium" where Chrome and its closer
 * relatives use "<Name> Safe Storage" / "<Name>", and the user-data directory
 * differs per fork and per platform.
 *
 * @module BrowserImportSources
 */
import type { BrowserImportSourceId, BrowserImportSourceProfile } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type BrowserImportEngine = "chromium" | "firefox";

/**
 * Directory roots a definition builds its paths from. Passed in rather than
 * read from `process`, so source resolution stays testable for platforms the
 * host is not currently running.
 */
export interface BrowserImportPathContext {
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** `%APPDATA%` on Windows; unused elsewhere. */
  readonly appData: string | undefined;
  /** `%LOCALAPPDATA%` on Windows; unused elsewhere. */
  readonly localAppData: string | undefined;
}

export interface BrowserImportSourceDefinition {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  readonly engine: BrowserImportEngine;
  /** Platforms the definition has paths for. */
  readonly platforms: ReadonlyArray<NodeJS.Platform>;
  readonly userDataDirectory: (context: BrowserImportPathContext) => string | undefined;
  /** Chromium on macOS only: where the OSCrypt key lives in the keychain. */
  readonly keychainService?: string;
  readonly keychainAccount?: string;
}

const macApplicationSupport = (
  context: BrowserImportPathContext,
  ...segments: ReadonlyArray<string>
) => context.path.join(context.home, "Library", "Application Support", ...segments);

/**
 * One Chromium fork across the three platforms. The macOS and Linux leaves
 * differ per fork, and Windows nests everything under a `User Data` directory.
 * Omitting a platform's segments marks the fork as unavailable there.
 */
const chromiumSource = (input: {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  readonly macSegments: ReadonlyArray<string>;
  readonly windowsSegments?: ReadonlyArray<string>;
  readonly linuxSegments?: ReadonlyArray<string>;
}): BrowserImportSourceDefinition => ({
  id: input.id,
  name: input.name,
  engine: "chromium",
  platforms: [
    "darwin" as NodeJS.Platform,
    ...(input.windowsSegments ? ["win32" as NodeJS.Platform] : []),
    ...(input.linuxSegments ? ["linux" as NodeJS.Platform] : []),
  ],
  keychainService: input.keychainService,
  keychainAccount: input.keychainAccount,
  userDataDirectory: (context) => {
    if (context.platform === "darwin") return macApplicationSupport(context, ...input.macSegments);
    if (context.platform === "win32") {
      return input.windowsSegments && context.localAppData
        ? context.path.join(context.localAppData, ...input.windowsSegments, "User Data")
        : undefined;
    }
    return input.linuxSegments
      ? context.path.join(context.home, ".config", ...input.linuxSegments)
      : undefined;
  },
});

export const BROWSER_IMPORT_SOURCES: ReadonlyArray<BrowserImportSourceDefinition> = [
  chromiumSource({
    id: "chrome",
    name: "Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    macSegments: ["Google", "Chrome"],
    windowsSegments: ["Google", "Chrome"],
    linuxSegments: ["google-chrome"],
  }),
  chromiumSource({
    id: "edge",
    name: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
    macSegments: ["Microsoft Edge"],
    windowsSegments: ["Microsoft", "Edge"],
    linuxSegments: ["microsoft-edge"],
  }),
  chromiumSource({
    id: "brave",
    name: "Brave",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
    macSegments: ["BraveSoftware", "Brave-Browser"],
    windowsSegments: ["BraveSoftware", "Brave-Browser"],
    linuxSegments: ["BraveSoftware", "Brave-Browser"],
  }),
  chromiumSource({
    id: "vivaldi",
    name: "Vivaldi",
    keychainService: "Vivaldi Safe Storage",
    keychainAccount: "Vivaldi",
    macSegments: ["Vivaldi"],
    windowsSegments: ["Vivaldi"],
    linuxSegments: ["vivaldi"],
  }),
  chromiumSource({
    id: "opera",
    name: "Opera",
    keychainService: "Opera Safe Storage",
    keychainAccount: "Opera",
    macSegments: ["com.operasoftware.Opera"],
    windowsSegments: ["Programs", "Opera"],
    linuxSegments: ["opera"],
  }),
  // Arc and Helium ship macOS-only builds.
  chromiumSource({
    id: "arc",
    name: "Arc",
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
    macSegments: ["Arc", "User Data"],
  }),
  chromiumSource({
    id: "helium",
    name: "Helium",
    keychainService: "Helium Storage Key",
    keychainAccount: "Helium",
    macSegments: ["net.imput.helium"],
  }),
  {
    id: "firefox",
    name: "Firefox",
    engine: "firefox",
    platforms: ["darwin", "win32", "linux"],
    userDataDirectory: (context) => {
      if (context.platform === "darwin") return macApplicationSupport(context, "Firefox");
      if (context.platform === "win32") {
        return context.appData
          ? context.path.join(context.appData, "Mozilla", "Firefox")
          : undefined;
      }
      return context.path.join(context.home, ".mozilla", "firefox");
    },
  },
];

/**
 * Chromium stores the database as `Cookies` under the profile directory;
 * Firefox uses `cookies.sqlite`, and its profile paths from `profiles.ini`
 * may already be absolute.
 */
export const cookieDatabasePath = (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string,
): string | undefined => {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return undefined;
  const fileName = definition.engine === "firefox" ? "cookies.sqlite" : "Cookies";
  return context.path.isAbsolute(profileDirectory)
    ? context.path.join(profileDirectory, fileName)
    : context.path.join(root, profileDirectory, fileName);
};

/**
 * Firefox records its profiles in `profiles.ini`. `Install*` sections point at
 * a default profile but do not describe one, so only `[ProfileN]` blocks
 * count.
 */
export function parseFirefoxProfiles(ini: string): ReadonlyArray<BrowserImportSourceProfile> {
  const profiles: BrowserImportSourceProfile[] = [];
  let current: { name?: string; path?: string } | null = null;

  const flush = () => {
    if (current?.path) {
      profiles.push({ directory: current.path, name: current.name?.trim() || current.path });
    }
    current = null;
  };

  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      flush();
      current = /^\[Profile\d+\]$/i.test(line) ? {} : null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "name") current.name = value;
    if (key === "path") current.path = value;
  }
  flush();
  return profiles;
}

/**
 * Resolves the roots the registry builds its paths from, from the ambient
 * process. Tests build a context directly instead.
 */
export const sourcePathContext = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  return {
    path,
    platform,
    home: environment.HOME ?? environment.USERPROFILE ?? "",
    appData: environment.APPDATA,
    localAppData: environment.LOCALAPPDATA,
  } satisfies BrowserImportPathContext;
});

/**
 * Whether a directory entry exists, without following it or opening it.
 *
 * Both `stat` and `exists` resolve symlinks, and the locks below deliberately
 * dangle — Chromium points `SingletonLock` at `<host>-<pid>` and Firefox
 * points `lock` at `<ip>:+<pid>`, neither of which exists on disk. Following
 * them reports every running browser as closed, which would let an import read
 * a live, mid-write database. `readLink` is the probe that answers for the
 * entry itself.
 *
 * Not opening the file is what lets Safari be detected: TCC permits `stat` on
 * the jar inside its container but refuses a read.
 */
const entryExists = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(path).pipe(
    Effect.catchCause(() => fileSystem.readLink(path)),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

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

/**
 * Profiles the source browser knows about.
 *
 * Firefox declares them in `profiles.ini`; Chromium in `Local State`. When
 * that metadata is missing, unreadable or malformed, the directories that
 * actually hold a cookie database are scanned instead. Assuming a single
 * `Default` would report a browser whose cookies live in `Profile 1` as having
 * nothing to import — and it is then left out of the menu entirely.
 */
export const listSourceProfiles = Effect.fn("BrowserImportSources.listSourceProfiles")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<ReadonlyArray<BrowserImportSourceProfile>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];

  if (definition.engine === "firefox") {
    const declared = yield* fileSystem.readFileString(context.path.join(root, "profiles.ini")).pipe(
      Effect.map(parseFirefoxProfiles),
      Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
    );
    if (declared.length > 0) return declared;

    // No readable `profiles.ini`, so fall back to scanning the directory the
    // profiles actually live in.
    return yield* fileSystem.readDirectory(context.path.join(root, "Profiles")).pipe(
      Effect.map((entries) =>
        entries.map((entry) => ({ directory: context.path.join("Profiles", entry), name: entry })),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
    );
  }

  const declared = yield* fileSystem.readFileString(context.path.join(root, "Local State")).pipe(
    Effect.flatMap(decodeLocalState),
    Effect.map((state) => Object.entries(state.profile?.info_cache ?? {})),
    // The keys are directory names from the browser's own metadata file, which
    // anything running as the user can write. Anything but a single plain
    // segment is dropped: `..` or a path separator would otherwise be handed
    // to `cookieDatabasePath` and read a database outside the user-data
    // directory.
    Effect.map((entries) => entries.filter(([directory]) => isSafeProfileDirectory(directory))),
    Effect.map((entries) =>
      entries.map(([directory, info]) => ({ directory, name: info.name?.trim() || directory })),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
  );
  if (declared.length > 0) return declared;

  // `Local State` is missing, unreadable or malformed. Scanning for directories
  // that hold a cookie database finds the profiles anyway.
  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const found = yield* Effect.forEach(entries.filter(isSafeProfileDirectory), (directory) =>
    entryExists(cookieDatabasePath(definition, context, directory) ?? "").pipe(
      Effect.map((exists) => (exists ? { directory, name: directory } : undefined)),
    ),
  );
  return found.filter((profile) => profile !== undefined);
});

/** Whether the browser is running, which leaves its cookie DB mid-write. */
export const isSourceRunning = Effect.fn("BrowserImportSources.isSourceRunning")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return false;
  // Chromium writes a `SingletonLock` symlink and Firefox a `lock` /
  // `parent.lock` for as long as an instance holds the profile. Far cheaper
  // and more targeted than scanning the process table for a name.
  const locks = definition.engine === "firefox" ? ["lock", "parent.lock"] : ["SingletonLock"];
  const found = yield* Effect.forEach(locks, (lock) => entryExists(context.path.join(root, lock)));
  return found.some(Boolean);
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
  context: BrowserImportPathContext,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
  const profiles = yield* listSourceProfiles(definition, context);
  const found = yield* Effect.forEach(profiles, (profile) => {
    const database = cookieDatabasePath(definition, context, profile.directory);
    return database === undefined ? Effect.succeed(false) : entryExists(database);
  });
  return found.some(Boolean);
});

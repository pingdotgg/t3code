/**
 * Importable browser sources.
 *
 * Chromium-family browsers keep cookies in an
 * encrypted SQLite database whose key lives in an OS credential store; Firefox
 * keeps them in plain SQLite with no key at all, so it needs no keychain and
 * works the same on every platform. Safari uses binary cookie files, with
 * separate WebKit data stores for named profiles.
 *
 * Each entry pins its own paths and credential-store coordinates rather than
 * deriving them, because the forks do not agree. macOS uses service/account
 * pairs, while Linux Chromium uses a custom libsecret schema keyed by an
 * `application` attribute. The user-data directory also differs per fork and
 * per platform.
 *
 * @module BrowserImportSources
 */
import type { BrowserImportSourceId, BrowserImportSourceProfile } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  HostProcessEnvironment,
  HostProcessAddresses,
  HostProcessHostname,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type BrowserImportEngine = "chromium" | "firefox" | "safari";

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
  /** Chromium's `application` attribute in the Linux libsecret schema. */
  readonly linuxSecretApplication?: string;
}

const macApplicationSupport = (
  context: BrowserImportPathContext,
  ...segments: ReadonlyArray<string>
) => context.path.join(context.home, "Library", "Application Support", ...segments);

/**
 * One Chromium fork. The leaves differ per fork; omitting a platform's
 * segments marks the fork as unavailable there. Most Windows Chromium builds
 * use App-Bound Encryption, but forks can retain the older DPAPI-backed store.
 */
const chromiumSource = (input: {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  readonly macSegments: ReadonlyArray<string>;
  readonly linuxSegments?: ReadonlyArray<string>;
  readonly linuxSecretApplication?: string;
  readonly windowsSegments?: ReadonlyArray<string>;
}): BrowserImportSourceDefinition => ({
  id: input.id,
  name: input.name,
  engine: "chromium",
  platforms: [
    "darwin" as NodeJS.Platform,
    ...(input.linuxSegments ? ["linux" as NodeJS.Platform] : []),
    ...(input.windowsSegments ? ["win32" as NodeJS.Platform] : []),
  ],
  keychainService: input.keychainService,
  keychainAccount: input.keychainAccount,
  ...(input.linuxSecretApplication === undefined
    ? {}
    : { linuxSecretApplication: input.linuxSecretApplication }),
  userDataDirectory: (context) => {
    if (context.platform === "darwin") return macApplicationSupport(context, ...input.macSegments);
    if (context.platform === "win32") {
      return input.windowsSegments && context.localAppData
        ? context.path.join(context.localAppData, ...input.windowsSegments)
        : undefined;
    }
    return input.linuxSegments
      ? context.path.join(context.home, ".config", ...input.linuxSegments)
      : undefined;
  },
});

export const BROWSER_IMPORT_SOURCES: ReadonlyArray<BrowserImportSourceDefinition> = [
  // No Chromium fork is importable on Windows: since Chrome 127 their cookies
  // are encrypted to the browser's own identity (App-Bound Encryption), so no
  // other process can read them. macOS and Linux keep working, so only the
  // Windows segments are omitted.
  chromiumSource({
    id: "chrome",
    name: "Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    macSegments: ["Google", "Chrome"],
    linuxSegments: ["google-chrome"],
    linuxSecretApplication: "chrome",
  }),
  chromiumSource({
    id: "edge",
    name: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
    macSegments: ["Microsoft Edge"],
    linuxSegments: ["microsoft-edge"],
    linuxSecretApplication: "msedge",
  }),
  chromiumSource({
    id: "brave",
    name: "Brave",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
    macSegments: ["BraveSoftware", "Brave-Browser"],
    linuxSegments: ["BraveSoftware", "Brave-Browser"],
    linuxSecretApplication: "brave",
  }),
  chromiumSource({
    id: "vivaldi",
    name: "Vivaldi",
    keychainService: "Vivaldi Safe Storage",
    keychainAccount: "Vivaldi",
    macSegments: ["Vivaldi"],
    linuxSegments: ["vivaldi"],
    linuxSecretApplication: "vivaldi",
  }),
  chromiumSource({
    id: "opera",
    name: "Opera",
    keychainService: "Opera Safe Storage",
    keychainAccount: "Opera",
    macSegments: ["com.operasoftware.Opera"],
    linuxSegments: ["opera"],
    linuxSecretApplication: "opera",
  }),
  // Arc has no Linux build.
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
    linuxSegments: ["net.imput.helium"],
    windowsSegments: ["imput", "Helium", "User Data"],
    // Helium retains Chromium's libsecret application name on Linux.
    linuxSecretApplication: "chromium",
  }),
  {
    // The default jar lives here; named profiles use WebKit data stores
    // alongside this directory inside the same app container.
    id: "safari",
    name: "Safari",
    engine: "safari",
    platforms: ["darwin"],
    userDataDirectory: (context) =>
      context.platform === "darwin"
        ? context.path.join(
            context.home,
            "Library",
            "Containers",
            "com.apple.Safari",
            "Data",
            "Library",
            "Cookies",
          )
        : undefined,
  },
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
 * Where a profile's cookie database may live, most current first. Chromium 96
 * moved the live jar to `Network/Cookies`; a root-level `Cookies` is either a
 * pre-96 install or a leftover from before the move. Importing the leftover
 * while sessions live in `Network/` would snapshot a stale or empty database,
 * and a fresh install with only `Network/Cookies` would read as not installed.
 * Firefox uses `cookies.sqlite`, and its profile paths from `profiles.ini`
 * may already be absolute.
 *
 * Chrome 96+ moved network-related files (including Cookies) into a `Network`
 * subdirectory for sandboxing. The candidate list includes both locations so
 * callers tolerate fresh and legacy installs alike.
 */
export const cookieDatabaseCandidatePaths = (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string,
): ReadonlyArray<string> => {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const profilePath = context.path.isAbsolute(profileDirectory)
    ? profileDirectory
    : context.path.join(root, profileDirectory);
  if (definition.engine === "firefox") {
    return [context.path.join(profilePath, "cookies.sqlite")];
  }
  if (definition.engine === "safari") {
    return [context.path.join(profilePath, "Cookies.binarycookies")];
  }
  // Chromium: pre-96 uses `Cookies`, 96+ use `Network/Cookies`. An upgrade
  // leaves the legacy file behind, so prefer the current one and fall back.
  return [
    context.path.join(profilePath, "Network", "Cookies"),
    context.path.join(profilePath, "Cookies"),
  ];
};

/** The first candidate that is a regular file, or undefined when none is. */
export const resolveCookieDatabase = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string,
) {
  for (const candidate of cookieDatabaseCandidatePaths(definition, context, profileDirectory)) {
    if (yield* databaseFileExists(candidate)) return candidate;
  }
  return undefined;
});

/**
 * Firefox records its profiles in `profiles.ini`. `Install*` sections point at
 * a default profile but do not describe one, so only `[ProfileN]` blocks
 * count.
 */
export function parseFirefoxProfiles(
  ini: string,
  path: Path.Path,
  root: string,
): ReadonlyArray<BrowserImportSourceProfile> {
  const profiles: BrowserImportSourceProfile[] = [];
  let current: { name?: string; path?: string; isRelative?: string } | null = null;

  const flush = () => {
    if (current?.path) {
      const candidate = current.path;
      const isRelative = current.isRelative === undefined || current.isRelative === "1";
      const validIsRelative = current.isRelative === undefined || /^[01]$/.test(current.isRelative);
      if (!validIsRelative || candidate.includes("\u0000")) {
        current = null;
        return;
      }

      let directory: string | undefined;
      if (isRelative) {
        if (!path.isAbsolute(candidate)) {
          const resolved = path.resolve(root, candidate);
          const relative = path.relative(root, resolved);
          const escapesRoot =
            relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
          if (!escapesRoot) directory = path.normalize(candidate);
        }
      } else if (path.isAbsolute(candidate)) {
        // Firefox supports profiles on arbitrary custom roots when
        // IsRelative=0. Do not constrain them to the standard Firefox root.
        directory = path.normalize(candidate);
      }

      if (directory !== undefined) {
        profiles.push({ directory, name: current.name?.trim() || directory });
      }
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
    if (key === "isrelative") current.isRelative = value;
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
 * How many importable cookies a profile holds, counted without decrypting
 * anything. Firefox containers use identities Electron cannot represent, so
 * its count uses the same default-container predicate as the reader. Best
 * effort: a locked, missing or unexpected database yields `undefined` rather
 * than failing the listing.
 */
const countProfileCookies = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  directory: string,
): Effect.fn.Return<number | undefined, never, FileSystem.FileSystem> {
  const database = yield* resolveCookieDatabase(definition, context, directory);
  if (database === undefined) return undefined;
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      definition.engine === "firefox"
        ? yield* sql`select count(*) as count from moz_cookies where originAttributes = ''`
        : yield* sql`select count(*) as count from cookies`;
    const [row] = yield* decodeCookieCount(rows);
    return row?.count;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: database, readonly: true })),
    Effect.orElseSucceed(() => undefined),
  );
});

const withCookieCounts = (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profiles: ReadonlyArray<BrowserImportSourceProfile>,
) =>
  Effect.forEach(profiles, (profile) =>
    countProfileCookies(definition, context, profile.directory).pipe(
      Effect.map((cookieCount) =>
        cookieCount === undefined ? profile : { ...profile, cookieCount },
      ),
    ),
  );

const SafariProfileRows = Schema.Array(
  Schema.Struct({ title: Schema.NullOr(Schema.String), external_uuid: Schema.String }),
);
const decodeSafariProfiles = Schema.decodeUnknownEffect(SafariProfileRows);
const isSafariProfileUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const listSafariProfiles = Effect.fnUntraced(function* (
  context: BrowserImportPathContext,
  root: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const library = context.path.dirname(root);
  const metadata = context.path.join(library, "Safari", "SafariTabs.db");
  const declared = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* decodeSafariProfiles(
      yield* sql`
      select title, external_uuid from bookmarks
      where parent = 0 and type = 1 and subtype = 2 and deleted = 0
      order by order_index
    `,
    );
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: metadata, readonly: true })),
    Effect.orElseSucceed(() => []),
  );
  const defaultProfile = declared.find((profile) => profile.external_uuid === "DefaultProfile");
  const profiles: Array<BrowserImportSourceProfile> = [
    {
      directory: ".",
      name: defaultProfile ? defaultProfile.title?.trim() || "Personal" : "Safari",
    },
  ];
  const stores = context.path.join(library, "WebKit", "WebsiteDataStore");
  const profileDirectory = (uuid: string) =>
    context.path.join(stores, uuid.toLowerCase(), "Cookies");
  for (const profile of declared) {
    if (!isSafariProfileUuid(profile.external_uuid)) continue;
    profiles.push({
      directory: profileDirectory(profile.external_uuid),
      name: profile.title?.trim() || profile.external_uuid,
    });
  }
  // If Safari's metadata is unavailable, recover stores that have cookies.
  // With readable metadata, avoid resurrecting deleted profiles left on disk.
  if (declared.length === 0) {
    const entries = yield* fileSystem.readDirectory(stores).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries.filter(isSafariProfileUuid).sort()) {
      const directory = context.path.join(stores, entry, "Cookies");
      if (yield* databaseFileExists(context.path.join(directory, "Cookies.binarycookies"))) {
        profiles.push({ directory, name: entry });
      }
    }
  }
  return profiles;
});

/**
 * Profiles the source browser knows about.
 *
 * Firefox declares them in `profiles.ini`; Chromium in `Local State`. When
 * that metadata is missing, unreadable or malformed, the directories that
 * actually hold a cookie database are scanned instead. Assuming a single
 * `Default` would report a browser whose cookies live in `Profile 1` as having
 * nothing to import — and it is then left out of the menu entirely.
 */
const listSourceProfilesInDirectory = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<ReadonlyArray<BrowserImportSourceProfile>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];

  if (definition.engine === "safari") {
    return yield* listSafariProfiles(context, root);
  }

  if (definition.engine === "firefox") {
    const declared = yield* fileSystem.readFileString(context.path.join(root, "profiles.ini")).pipe(
      Effect.map((ini) => parseFirefoxProfiles(ini, context.path, root)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
    );
    // `profiles.ini` also lists profiles the installer created but the user
    // never launched, which hold no cookie database and nothing to import.
    // Only keep the ones a database proves exist, like the directory scans
    // below do. When none of the declared profiles has one, fall through to
    // the scan rather than returning empty: `profiles.ini` can list stale or
    // never-launched profiles while the cookies live in one it does not
    // mention, and an empty answer here hides the browser entirely.
    if (declared.length > 0) {
      const found = yield* Effect.forEach(declared, (profile) =>
        Effect.forEach(
          cookieDatabaseCandidatePaths(definition, context, profile.directory),
          (candidate) => databaseFileExists(candidate),
        ).pipe(Effect.map((results) => (results.some(Boolean) ? profile : undefined))),
      );
      const withDatabase = found.filter((profile) => profile !== undefined);
      if (withDatabase.length > 0) {
        return yield* withCookieCounts(definition, context, withDatabase);
      }
    }

    // No usable `profiles.ini`, so fall back to scanning the directory the
    // profiles actually live in, keeping only the ones a cookie database
    // proves were launched.
    const fallbackDirectory =
      context.platform === "linux" ? root : context.path.join(root, "Profiles");
    const scanned = yield* fileSystem
      .readDirectory(fallbackDirectory)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const found = yield* Effect.forEach(scanned, (entry) => {
      const directory = context.platform === "linux" ? entry : context.path.join("Profiles", entry);
      return resolveCookieDatabase(definition, context, directory).pipe(
        Effect.map((database) => (database === undefined ? undefined : { directory, name: entry })),
      );
    });
    return yield* withCookieCounts(
      definition,
      context,
      found.filter((profile) => profile !== undefined),
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
  if (declared.length > 0) return yield* withCookieCounts(definition, context, declared);

  // `Local State` is missing, unreadable or malformed. Scanning for directories
  // that hold a cookie database finds the profiles anyway.
  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const found = yield* Effect.forEach(entries.filter(isSafeProfileDirectory), (directory) =>
    resolveCookieDatabase(definition, context, directory).pipe(
      Effect.map((database) =>
        database === undefined ? undefined : { directory, name: directory },
      ),
    ),
  );
  return yield* withCookieCounts(
    definition,
    context,
    found.filter((profile) => profile !== undefined),
  );
});

/**
 * Include Firefox's Snap home alongside its native home. Snap profiles use
 * absolute directories so cookie reads and lock checks keep pointing at the
 * installation they came from, even when both installs use the same name.
 */
export const listSourceProfiles = Effect.fn("BrowserImportSources.listSourceProfiles")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<ReadonlyArray<BrowserImportSourceProfile>, never, FileSystem.FileSystem> {
  if (definition.engine !== "firefox" || context.platform !== "linux") {
    return yield* listSourceProfilesInDirectory(definition, context);
  }

  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const roots = [
    root,
    context.path.join(context.home, "snap", "firefox", "common", ".mozilla", "firefox"),
  ];
  const profiles = new Map<string, BrowserImportSourceProfile>();
  for (const directory of roots) {
    const found = yield* listSourceProfilesInDirectory(
      { ...definition, userDataDirectory: () => directory },
      context,
    );
    for (const profile of found) {
      const absolute = context.path.resolve(directory, profile.directory);
      if (!profiles.has(absolute)) {
        profiles.set(absolute, directory === root ? profile : { ...profile, directory: absolute });
      }
    }
  }
  return [...profiles.values()];
});

/**
 * Whether a cookie database candidate is a regular file. Presence alone is
 * not enough: a directory at the path would list as an importable profile and
 * then fail the SQLite open, so anything but a file is treated as absent.
 */
const databaseFileExists = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(path).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
});

type ProcessLivenessProbe = (pid: number) => Effect.Effect<boolean>;

export const chromiumProcessIsAlive = (
  pid: number,
  signalProcess: (pid: number, signal: 0) => unknown = process.kill.bind(process),
) =>
  Effect.sync(() => {
    try {
      // Signal 0 performs a read-only existence/permission check.
      signalProcess(pid, 0);
      return true;
    } catch (cause) {
      // Only ESRCH positively proves the process is gone. Permission errors
      // and unknown failures stay conservative so an active browser is never
      // mistaken for a stale lock.
      return !(
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ESRCH"
      );
    }
  });

const processIsAlive: ProcessLivenessProbe = (pid) => chromiumProcessIsAlive(pid);

/** Whether a Chromium `<host>-<pid>` lock target may still name its owner. */
export const chromiumSingletonLockIsHeld = Effect.fnUntraced(function* (
  target: string,
  currentHost: string,
  isProcessAlive: ProcessLivenessProbe,
) {
  const separator = target.lastIndexOf("-");
  if (separator <= 0) return true;
  const host = target.slice(0, separator);
  const pidText = target.slice(separator + 1);
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  // A PID is meaningful only on this host. A foreign hostname can come from a
  // shared home directory, and cannot safely be declared stale from here.
  if (host !== currentHost) return true;
  return yield* isProcessAlive(pid);
});

/** Windows sharing and lock violations are translated by libuv to `Busy`. */
export const isWindowsLockHeldError = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "Busy";

/**
 * Whether a Windows `parent.lock` is actually held by a running process. It
 * is opened with no sharing, so it persists on disk after the process exits
 * and `stat` always succeeds; only trying to open it for write reveals an
 * active holder, which surfaces as `Busy`.
 */
const windowsLockIsHeld = Effect.fnUntraced(function* (lockPath: string) {
  // Permission failures are distinct: they do not prove a browser owns the
  // lock, so they must not hide the source as running.
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.open(lockPath, { flag: "r+" }).pipe(
    Effect.as(false),
    Effect.catchIf(isWindowsLockHeldError, () => Effect.succeed(true)),
    Effect.orElseSucceed(() => false),
    Effect.scoped,
  );
});

type WindowsLockProbe = (path: string) => Effect.Effect<boolean, never, FileSystem.FileSystem>;

/**
 * Chromium does not create its POSIX `SingletonLock` symlink on Windows. The
 * live cookie database is opened without sharing instead, so probing each
 * profile's current jar is the reliable running signal there.
 */
export const windowsChromiumCookiesAreHeld = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  lockIsHeld: WindowsLockProbe = windowsLockIsHeld,
) {
  const profiles = yield* listSourceProfiles(definition, context);
  const held = yield* Effect.forEach(profiles, (profile) =>
    resolveCookieDatabase(definition, context, profile.directory).pipe(
      Effect.flatMap((database) =>
        database === undefined ? Effect.succeed(false) : lockIsHeld(database),
      ),
    ),
  );
  return held.some(Boolean);
});

/**
 * Whether a Firefox `lock` symlink's `<ip>:[+]<pid>` target still names a
 * live owner. Firefox writes this symlink beside the profile while it runs and
 * unlinks it on a clean exit, so a dangling one is either live or a crash.
 */
export const firefoxSymlinkLockIsHeld = Effect.fnUntraced(function* (
  target: string,
  localAddresses: ReadonlySet<string>,
  isProcessAlive: ProcessLivenessProbe,
) {
  const separator = target.lastIndexOf(":");
  if (separator < 0) return true;
  // The owner half is whatever Firefox's resolver returned for the machine's
  // hostname — 127.0.0.1 when the lookup fails, but often 127.0.1.1 or a LAN
  // address — so a pid is only meaningful when that address is one of ours.
  // A shared (NFS) profile locked from another machine names a foreign
  // address whose pid cannot be probed here, nor could a reused local pid
  // vouch for it, so it stays conservatively held.
  const owner = target.slice(0, separator);
  if (!localAddresses.has(owner)) return true;
  // A `+` marks an fcntl-holding owner; the pid follows either way.
  const pidText = target.slice(separator + 1).replace(/^\+/, "");
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  return yield* isProcessAlive(pid);
});

/**
 * Interpreters that can run the fcntl probe, tried in order. `/usr/bin/python3`
 * is named absolutely first so a Dock-launched app with launchd's bare `PATH`
 * still finds it without depending on the login-shell PATH merge; Linux
 * distributions carry python3 on the default path.
 */
const FCNTL_PROBE_INTERPRETERS = ["/usr/bin/python3", "python3"] as const;

/**
 * The probe prints exactly one of these. Anything else means the script never
 * ran — most importantly Apple's `/usr/bin/python3` shim, which on a Mac
 * without the Command Line Tools exits non-zero after printing an install
 * prompt, without ever reaching our code.
 */
const FCNTL_PROBE_SCRIPT =
  "import fcntl,os,sys\n" +
  "fd=os.open(sys.argv[1],os.O_WRONLY)\n" +
  "try:\n" +
  "  fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\n" +
  "except BlockingIOError:\n" +
  "  print('held')\n" +
  "else:\n" +
  "  print('free')";

/**
 * Whether another process holds an fcntl write lock on `path`.
 *
 * Firefox's `.parentlock` is an empty file whose only signal is the kernel
 * lock, and Node exposes no fcntl, so a throwaway interpreter tries a
 * non-blocking `F_SETLK` and reports `EWOULDBLOCK`. The lock is never
 * acquired for real: on success the child exits and the kernel drops it.
 *
 * The answer is trusted only when the script itself spoke. A verdict of
 * `held` or `free` on stdout is the probe's own, and stands. Anything else —
 * no interpreter on any candidate path, or one that refused to run the script
 * (Apple's shim without the developer tools) — is the probe being unavailable,
 * not evidence about the lock. That case falls back to "not held" rather than
 * "held": reporting every profile as locked forever would block Firefox import
 * outright on such machines, and the SQLite snapshot already copes with a
 * live database's WAL, as it does for every other engine.
 */
export const posixLockIsHeld = Effect.fnUntraced(function* (
  path: string,
  interpreters: ReadonlyArray<string> = FCNTL_PROBE_INTERPRETERS,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcessEnvironment;
  for (const interpreter of interpreters) {
    const verdict = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(interpreter, ["-c", FCNTL_PROBE_SCRIPT, path], {
            stdin: "ignore",
            env: environment,
          }),
        );
        const [stdout] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return stdout.trim();
      }),
    ).pipe(Effect.orElseSucceed(() => ""));
    if (verdict === "held") return true;
    if (verdict === "free") return false;
  }
  return false;
});

/**
 * Whether Firefox holds a profile.
 *
 * Firefox leaves two kinds of lock behind, and they mean different things.
 * On Linux the `lock` symlink (target `<ip>:+<pid>`) is removed on a clean
 * exit, so its presence is evidence — provided the pid it names is alive. But
 * `.parentlock` (macOS/Linux) and `parent.lock` (Windows) are regular files
 * held with fcntl or a Windows handle and are *deliberately left on disk*
 * after exit, as a last-used marker; treating them as proof of a running
 * browser blocks every import after Firefox has been used once. On POSIX the
 * fcntl lock itself is the truth, and macOS in particular writes nothing else
 * (no symlink, no pid), so `.parentlock` is probed for the kernel lock. On
 * Windows the held handle denies our open, which `windowsLockIsHeld` reads as `Busy`.
 */
const firefoxProfileIsHeld = Effect.fnUntraced(function* (
  directory: string,
  context: BrowserImportPathContext,
  // Resolved once by the caller: it involves a DNS lookup of the hostname and
  // is the same for every profile.
  localAddresses: ReadonlySet<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (context.platform === "win32") {
    return yield* windowsLockIsHeld(context.path.join(directory, "parent.lock"));
  }
  // Linux additionally writes the `lock` symlink; a live pid there settles it
  // without spawning anything.
  const symlinkHeld = yield* fileSystem.readLink(context.path.join(directory, "lock")).pipe(
    Effect.flatMap((target) => firefoxSymlinkLockIsHeld(target, localAddresses, processIsAlive)),
    Effect.orElseSucceed(() => false),
  );
  if (symlinkHeld) return true;
  const parentLock = context.path.join(directory, ".parentlock");
  const present = yield* fileSystem.stat(parentLock).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
  if (!present) return false;
  return yield* posixLockIsHeld(parentLock);
});

/** Whether the browser is running, which leaves its cookie DB mid-write. */
export const isSourceRunning = Effect.fn("BrowserImportSources.isSourceRunning")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<
  boolean,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = definition.userDataDirectory(context);
  if (root === undefined) return false;
  // Probe the source's own lock state rather than scanning the process table.
  // Safari keeps no lock and writes its jar atomically, so a running instance
  // is not a hazard there.
  //
  // Chromium exposes its lock through the cookie jar on Windows and through a
  // user-data SingletonLock on POSIX. Firefox keeps its locks inside each
  // profile under three names across platforms (`lock` on macOS and Linux,
  // `.parentlock` beside it, `parent.lock` on Windows). Looking for Firefox's
  // at the root finds nothing and reports a running browser as importable.
  if (definition.engine === "safari") return false;
  if (definition.engine !== "firefox") {
    if (context.platform === "win32") {
      return yield* windowsChromiumCookiesAreHeld(definition, context);
    }
    const currentHost = yield* HostProcessHostname;
    const lock = context.path.join(root, "SingletonLock");
    return yield* fileSystem.readLink(lock).pipe(
      Effect.flatMap((target) => chromiumSingletonLockIsHeld(target, currentHost, processIsAlive)),
      Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
    );
  }

  const profiles = yield* listSourceProfiles(definition, context);
  // Only the Linux `lock` symlink names an address, so Windows skips the lookup.
  const localAddresses: ReadonlySet<string> =
    context.platform === "win32" ? new Set() : yield* yield* HostProcessAddresses;
  const found = yield* Effect.forEach(profiles, (profile) => {
    const directory = context.path.isAbsolute(profile.directory)
      ? profile.directory
      : context.path.join(root, profile.directory);
    return firefoxProfileIsHeld(directory, context, localAddresses);
  });
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
  const found = yield* Effect.forEach(profiles, (profile) =>
    resolveCookieDatabase(definition, context, profile.directory).pipe(
      Effect.map((database) => database !== undefined),
    ),
  );
  return found.some(Boolean);
});

import type { BrowserImportSourceId, BrowserImportSourceProfile } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

export type BrowserImportEngine = "chromium" | "firefox" | "safari";

export interface BrowserImportPathContext {
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly appData: string | undefined;
  readonly localAppData: string | undefined;
}

export interface BrowserImportSourceDefinition {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  readonly engine: BrowserImportEngine;
  readonly platforms: ReadonlyArray<NodeJS.Platform>;
  readonly userDataDirectory: (context: BrowserImportPathContext) => string | undefined;
  readonly alternateLinuxRoots?: (context: BrowserImportPathContext) => ReadonlyArray<string>;
  readonly keychainService?: string;
  readonly keychainAccount?: string;
  readonly linuxSecretApplication?: string;
}

const macApplicationSupport = (
  context: BrowserImportPathContext,
  ...segments: ReadonlyArray<string>
) => context.path.join(context.home, "Library", "Application Support", ...segments);

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
  // Chrome 127+ App-Bound Encryption prevents other processes from reading Windows Chromium cookies.
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
    alternateLinuxRoots: (context) => [
      context.path.join(context.home, "snap", "firefox", "common", ".mozilla", "firefox"),
    ],
  },
  {
    id: "zen",
    name: "Zen",
    engine: "firefox",
    platforms: ["darwin", "win32", "linux"],
    userDataDirectory: (context) => {
      if (context.platform === "darwin") return macApplicationSupport(context, "zen");
      if (context.platform === "win32") {
        return context.appData ? context.path.join(context.appData, "zen") : undefined;
      }
      return context.path.join(context.home, ".config", "zen");
    },
    alternateLinuxRoots: (context) => [
      context.path.join(context.home, ".zen"),
      context.path.join(context.home, ".var", "app", "app.zen_browser.zen", "zen"),
    ],
  },
];

const cookieDatabaseCandidatePaths = (
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
  // Prefer Chromium 96+'s Network/Cookies; upgrades leave the pre-96 Cookies file behind.
  return [
    context.path.join(profilePath, "Network", "Cookies"),
    context.path.join(profilePath, "Cookies"),
  ];
};

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

/** Install* sections select defaults, not profiles; only ProfileN blocks describe profiles. */
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
        // IsRelative=0 permits custom roots outside Firefox's standard directory.
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

export const sourcePathContext = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  return {
    path,
    platform,
    home: environment.HOME ?? environment.USERPROFILE ?? "",
    appData: environment.APPDATA,
    localAppData: environment.LOCALAPPDATA,
  } satisfies BrowserImportPathContext;
});

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

const isSafeProfileDirectory = (directory: string): boolean =>
  directory.length > 0 &&
  directory !== "." &&
  directory !== ".." &&
  !/[\\/]/.test(directory) &&
  !directory.includes("\u0000");

const CookieCountRow = Schema.Struct({ count: Schema.Number });
const decodeCookieCount = Schema.decodeUnknownEffect(Schema.Array(CookieCountRow));

// Count only default-container cookies because Electron cannot represent Firefox containers.
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
    // Declared profiles may be stale or never launched; scan for unlisted stores if none has a cookie database.
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
    // Browser metadata is user-writable; reject traversal segments before resolving cookie database paths.
    Effect.map((entries) => entries.filter(([directory]) => isSafeProfileDirectory(directory))),
    Effect.map((entries) =>
      entries.map(([directory, info]) => ({ directory, name: info.name?.trim() || directory })),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
  );
  if (declared.length > 0) return yield* withCookieCounts(definition, context, declared);

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

/** Keep alternate-root profile paths absolute so cookie reads and locks use the correct installation. */
export const listSourceProfiles = Effect.fn("BrowserImportSources.listSourceProfiles")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<ReadonlyArray<BrowserImportSourceProfile>, never, FileSystem.FileSystem> {
  if (definition.engine !== "firefox" || context.platform !== "linux") {
    return yield* listSourceProfilesInDirectory(definition, context);
  }

  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const roots = [root, ...(definition.alternateLinuxRoots?.(context) ?? [])];
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
      signalProcess(pid, 0);
      return true;
    } catch (cause) {
      // Only ESRCH proves a stale lock; permission and unknown failures may still hide an active browser.
      return !(
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ESRCH"
      );
    }
  });

const processIsAlive: ProcessLivenessProbe = (pid) => chromiumProcessIsAlive(pid);

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
  // Foreign-host PIDs may come from a shared home; never declare them stale here.
  if (host !== currentHost) return true;
  return yield* isProcessAlive(pid);
});

/** Windows sharing and lock violations are translated by libuv to `Busy`. */
const isWindowsLockHeldError = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "Busy";

/** Windows leaves parent.lock after exit; only opening it for write reveals a live holder as Busy. */
const windowsLockIsHeld = Effect.fnUntraced(function* (lockPath: string) {
  // Permission failures do not prove a running browser owns the lock.
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.open(lockPath, { flag: "r+" }).pipe(
    Effect.as(false),
    Effect.catchIf(isWindowsLockHeldError, () => Effect.succeed(true)),
    Effect.orElseSucceed(() => false),
    Effect.scoped,
  );
});

type WindowsLockProbe = (path: string) => Effect.Effect<boolean, never, FileSystem.FileSystem>;

/** Windows Chromium locks cookie databases without sharing instead of creating POSIX SingletonLock symlinks. */
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

export const firefoxSymlinkLockIsHeld = Effect.fnUntraced(function* (
  target: string,
  localAddresses: ReadonlySet<string>,
  isProcessAlive: ProcessLivenessProbe,
) {
  const separator = target.lastIndexOf(":");
  if (separator < 0) return true;
  // Firefox resolves the hostname to loopback or LAN addresses; only local owners' PIDs are meaningful.
  const owner = target.slice(0, separator);
  if (!localAddresses.has(owner)) return true;
  // A `+` marks an fcntl-holding owner; the pid follows either way.
  const pidText = target.slice(separator + 1).replace(/^\+/, "");
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  return yield* isProcessAlive(pid);
});

/** Dock launches have a bare PATH; try the absolute interpreter before relying on shell discovery. */
const FCNTL_PROBE_INTERPRETERS = ["/usr/bin/python3", "python3"] as const;

/** Apple's python3 shim can fail with an install prompt before the probe script runs. */
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
 * A missing or refusing interpreter (Apple's shim without developer tools) means
 * the probe is unavailable, so report "not held": "held" would block Firefox import
 * forever, and the SQLite snapshot already copes with a live WAL.
 */
const posixLockIsHeld = Effect.fnUntraced(function* (
  path: string,
  interpreters: ReadonlyArray<string> = FCNTL_PROBE_INTERPRETERS,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcess.Environment;
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

/** Firefox leaves regular lock files after exit; test the lock, not file existence. */
const firefoxProfileIsHeld = Effect.fnUntraced(function* (
  directory: string,
  context: BrowserImportPathContext,
  localAddresses: ReadonlySet<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (context.platform === "win32") {
    return yield* windowsLockIsHeld(context.path.join(directory, "parent.lock"));
  }
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
  // Safari writes its jar atomically and needs no lock, even while running.
  if (definition.engine === "safari") return false;
  if (definition.engine !== "firefox") {
    if (context.platform === "win32") {
      return yield* windowsChromiumCookiesAreHeld(definition, context);
    }
    const currentHost = yield* HostProcess.Hostname;
    const lock = context.path.join(root, "SingletonLock");
    return yield* fileSystem.readLink(lock).pipe(
      Effect.flatMap((target) => chromiumSingletonLockIsHeld(target, currentHost, processIsAlive)),
      Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
    );
  }

  const profiles = yield* listSourceProfiles(definition, context);
  const localAddresses: ReadonlySet<string> =
    context.platform === "win32" ? new Set() : yield* yield* HostProcess.Addresses;
  const found = yield* Effect.forEach(profiles, (profile) => {
    const directory = context.path.isAbsolute(profile.directory)
      ? profile.directory
      : context.path.join(root, profile.directory);
    return firefoxProfileIsHeld(directory, context, localAddresses);
  });
  return found.some(Boolean);
});

/** Require a cookie database; installers create empty directories. Safari stat needs no Full Disk Access. */
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

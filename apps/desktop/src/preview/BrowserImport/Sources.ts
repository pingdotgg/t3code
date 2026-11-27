import type { BrowserImportSourceId, BrowserImportSourceProfile } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { decodeWindowsWrappedKey, type KeychainCredentialCandidate } from "./ChromiumKeys.ts";

export type BrowserImportEngine = "chromium" | "firefox" | "safari";

export interface BrowserImportPathContext {
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly linuxConfigHome: string;
  readonly linuxChromeConfigHome: string;
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
  readonly keychainCandidates?: ReadonlyArray<KeychainCredentialCandidate>;
  readonly linuxSecretApplication?: string;
  readonly linuxSecretApplications?: ReadonlyArray<string>;
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
  readonly linuxSecretApplications?: ReadonlyArray<string>;
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
  ...(input.linuxSecretApplications === undefined
    ? {}
    : { linuxSecretApplications: input.linuxSecretApplications }),
  userDataDirectory: (context) => {
    if (context.platform === "darwin") return macApplicationSupport(context, ...input.macSegments);
    if (context.platform === "win32") {
      return input.windowsSegments && context.localAppData
        ? context.path.join(context.localAppData, ...input.windowsSegments)
        : undefined;
    }
    return input.linuxSegments
      ? context.path.join(
          input.id === "chrome" || input.id === "chromium"
            ? context.linuxChromeConfigHome
            : context.linuxConfigHome,
          ...input.linuxSegments,
        )
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
    id: "chromium",
    name: "Chromium",
    keychainService: "Chromium Safe Storage",
    keychainAccount: "Chromium",
    macSegments: ["Chromium"],
    linuxSegments: ["chromium"],
    linuxSecretApplication: "chromium",
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
    // Vivaldi stores its Linux libsecret key under Chrome's application name.
    linuxSecretApplication: "chrome",
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
    id: "dia",
    name: "Dia",
    keychainService: "Dia Safe Storage",
    keychainAccount: "Dia",
    macSegments: ["Dia", "User Data"],
  }),
  chromiumSource({
    id: "ardia",
    name: "Ardia",
    keychainService: "Ardia Safe Storage",
    keychainAccount: "Ardia",
    macSegments: ["com.ardia.browser", "Chromium"],
    linuxSegments: ["ardia"],
    linuxSecretApplication: "ardia",
    linuxSecretApplications: ["ardia", "chromium", "chrome"],
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
      return context.path.join(context.linuxConfigHome, "zen");
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

// Prefix check on resolved paths preserves case on Windows too (unlike `path.win32.relative`).
export const isWithinRoot = (path: Path.Path, root: string, candidate: string): boolean => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolvedCandidate.startsWith(prefix);
};

const resolveFileWithinRoot = Effect.fnUntraced(function* (
  root: string,
  candidate: string,
  context: BrowserImportPathContext,
  requirePinnedRoot: boolean,
) {
  if (!isWithinRoot(context.path, root, candidate)) return undefined;
  if (!(yield* databaseFileExists(candidate))) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.all([fileSystem.realPath(root), fileSystem.realPath(candidate)]).pipe(
    Effect.map(([realRoot, realCandidate]) => {
      if (requirePinnedRoot && realRoot !== root) {
        return undefined;
      }
      return isWithinRoot(context.path, realRoot, realCandidate) ? realCandidate : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );
});

const isPinnedRootUnchanged = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.realPath(root).pipe(
    Effect.map((realRoot) => realRoot === root),
    Effect.orElseSucceed(() => false),
  );
});

export const resolveChromiumLocalState = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
) {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return undefined;
  const candidate = context.path.join(root, "Local State");
  if (!definition.id.startsWith("discovered:")) return candidate;
  return yield* resolveFileWithinRoot(root, candidate, context, true);
});

export const resolveCookieDatabase = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string,
) {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return undefined;
  const enforceRootContainment = definition.id.startsWith("discovered:");
  for (const candidate of cookieDatabaseCandidatePaths(definition, context, profileDirectory)) {
    if (enforceRootContainment) {
      const canonical = yield* resolveFileWithinRoot(root, candidate, context, true);
      if (canonical !== undefined) return canonical;
    } else if (yield* databaseFileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
});

/** Install* sections select defaults, not profiles; only ProfileN blocks describe profiles. */
export function parseFirefoxProfiles(
  ini: string,
  path: Path.Path,
  root: string,
  allowExternalProfiles = true,
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
        if (!path.isAbsolute(candidate) && isWithinRoot(path, root, candidate)) {
          directory = path.normalize(candidate);
        }
      } else if (
        path.isAbsolute(candidate) &&
        (allowExternalProfiles || isWithinRoot(path, root, candidate))
      ) {
        // IsRelative=0 permits custom roots outside Firefox's standard directory for registered sources.
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
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  const linuxConfigHome =
    xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(home, ".config");
  const chromeConfigHome = environment.CHROME_CONFIG_HOME;
  return {
    path,
    platform,
    home,
    linuxConfigHome,
    linuxChromeConfigHome:
      chromeConfigHome && path.isAbsolute(chromeConfigHome) ? chromeConfigHome : linuxConfigHome,
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
    // readChromiumCookieDatabase imports a razed jar as empty; Firefox has no such reader guard.
    if (definition.engine !== "firefox") {
      const tables =
        yield* sql`select 1 from sqlite_master where type = 'table' and name = 'cookies'`;
      if (tables.length === 0) return 0;
    }
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

  const isDiscovered = definition.id.startsWith("discovered:");
  if (isDiscovered && !(yield* isPinnedRootUnchanged(root))) return [];

  if (definition.engine === "firefox") {
    const profilesIniPath = isDiscovered
      ? yield* resolveFileWithinRoot(root, context.path.join(root, "profiles.ini"), context, true)
      : context.path.join(root, "profiles.ini");
    const declared =
      profilesIniPath === undefined
        ? ([] as ReadonlyArray<BrowserImportSourceProfile>)
        : yield* fileSystem.readFileString(profilesIniPath).pipe(
            Effect.map((ini) => parseFirefoxProfiles(ini, context.path, root, !isDiscovered)),
            Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
          );
    // Declared profiles may be stale or never launched; scan for unlisted stores if none has a cookie database.
    if (declared.length > 0) {
      const found = yield* Effect.forEach(declared, (profile) =>
        resolveCookieDatabase(definition, context, profile.directory).pipe(
          Effect.map((database) => (database === undefined ? undefined : profile)),
        ),
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

  const localStatePath = yield* resolveChromiumLocalState(definition, context);
  const declared =
    localStatePath === undefined
      ? ([] as ReadonlyArray<BrowserImportSourceProfile>)
      : yield* fileSystem.readFileString(localStatePath).pipe(
          Effect.flatMap(decodeLocalState),
          Effect.map((state) => Object.entries(state.profile?.info_cache ?? {})),
          // Browser metadata is user-writable; reject traversal segments before resolving cookie database paths.
          Effect.map((entries) =>
            entries.filter(([directory]) => isSafeProfileDirectory(directory)),
          ),
          Effect.map((entries) =>
            entries.map(([directory, info]) => ({
              directory,
              name: info.name?.trim() || directory,
            })),
          ),
          Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
        );
  if (declared.length > 0) {
    if (!isDiscovered) return yield* withCookieCounts(definition, context, declared);
    const valid = (yield* Effect.forEach(declared, (profile) =>
      resolveCookieDatabase(definition, context, profile.directory).pipe(
        Effect.map((database) => (database === undefined ? undefined : profile)),
      ),
    )).filter((profile) => profile !== undefined);
    return yield* withCookieCounts(definition, context, valid);
  }

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

const MAX_NESTED_SCAN_ENTRIES = 64;

// Skip macOS TCC-protected folders, Windows WebView2 containers, Electron, and T3 Code itself.
const IGNORED_DISCOVERY_NAMES = new Set([
  "addressbook",
  "apple",
  "caches",
  "callhistorydb",
  "callhistorytransactions",
  "clouddocs",
  "crashdumps",
  "crashreporter",
  "d3dscache",
  "ebwebview",
  "edgewebview",
  "electron",
  "elevateddiagnostics",
  "facetime",
  "fileprovider",
  "icloud",
  "knowledge",
  "logs",
  "mobilesync",
  "node_modules",
  "npm-cache",
  "nuget",
  "packages",
  "pnpm",
  "programs",
  "squirreltemp",
  "syncservices",
  "t3 code",
  "t3 code (beta)",
  "t3 code (nightly)",
  "t3-code",
  "t3code",
  "temp",
  "ubiquity",
  "webview2",
]);

const GENERIC_SEGMENTS = new Set([
  "browser",
  "chromium",
  "config",
  "data",
  "profile",
  "profiles",
  "user data",
]);
const GENERIC_BUNDLE_TAILS = new Set(["app", "browser", "client", "desktop", "mac", "macos"]);
const REVERSE_DNS_TLDS = new Set(["app", "com", "dev", "io", "net", "org"]);
const KEYCHAIN_BRAND_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["chrome", "Chrome"],
  ["brave", "Brave"],
  ["edge", "Microsoft Edge"],
  ["microsoft edge", "Microsoft Edge"],
  ["opera", "Opera"],
  ["vivaldi", "Vivaldi"],
];

const shouldSkipDirectoryName = (name: string): boolean => {
  const lower = name.toLowerCase();
  return (
    name.startsWith(".") ||
    lower.startsWith("com.apple.") ||
    lower.startsWith("com.t3tools.") ||
    IGNORED_DISCOVERY_NAMES.has(lower)
  );
};

const stripReverseDns = (segment: string): string => {
  const parts = segment.split(".").filter(Boolean);
  if (parts.length < 3 || !REVERSE_DNS_TLDS.has(parts[0]!.toLowerCase())) return segment;
  const last = parts[parts.length - 1]!;
  return GENERIC_BUNDLE_TAILS.has(last.toLowerCase()) ? parts[parts.length - 2]! : last;
};

export function deriveDiscoveredBrowserName(segments: ReadonlyArray<string>): string | undefined {
  const cleaned = segments.map((segment) => segment.trim()).filter(Boolean);
  while (cleaned.length > 1 && GENERIC_SEGMENTS.has(cleaned[cleaned.length - 1]!.toLowerCase())) {
    cleaned.pop();
  }
  const leaf = cleaned[cleaned.length - 1]?.replace(/^\.+/, "");
  if (!leaf) return undefined;
  const name = stripReverseDns(leaf)
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word === word.toLowerCase() ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
  return !name || IGNORED_DISCOVERY_NAMES.has(name.toLowerCase()) ? undefined : name;
}

export function discoveredChromiumKeychainCandidates(
  name: string,
): ReadonlyArray<KeychainCredentialCandidate> {
  const candidates: Array<KeychainCredentialCandidate> = [];
  const seen = new Set<string>();
  const push = (service: string, account: string) => {
    const key = `${service}\0${account}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ service, account });
    }
  };
  push(`${name} Safe Storage`, name);
  push(`${name} Safe Storage`, "Chrome");
  push(`${name} Storage Key`, name);
  const lower = name.toLowerCase();
  for (const [prefix, brand] of KEYCHAIN_BRAND_PREFIXES) {
    if (lower.startsWith(prefix) && brand.toLowerCase() !== lower) {
      push(`${brand} Safe Storage`, brand);
    }
  }
  push("Chromium Safe Storage", "Chromium");
  return candidates;
}

export function discoveredLinuxSecretApplications(
  segments: ReadonlyArray<string>,
  name: string,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = value?.trim().toLowerCase();
    if (normalized) seen.add(normalized);
  };
  const leaf = segments[segments.length - 1]?.replace(/^\.+/, "");
  if (leaf) {
    const stripped = stripReverseDns(leaf);
    push(leaf);
    push(stripped);
    push(stripped.split(/[-_\s]+/)[0]);
  }
  push(name.replace(/\s+/g, "-"));
  push(name.split(/\s+/)[0]);
  push("chromium");
  push("chrome");
  return [...seen];
}

// Deduplicate by filesystem inode when available so case-insensitive macOS/Windows aliases
// collapse to one entry even if `realPath` preserves input casing, while distinct dirs stay separate.
const rootDedupeKey = Effect.fnUntraced(function* (
  context: BrowserImportPathContext,
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const inodeKey = yield* fileSystem.stat(directory).pipe(
    Effect.map((info) =>
      Option.isSome(info.ino) && info.ino.value > 0n
        ? `ino:${info.dev}:${info.ino.value}`
        : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );
  if (inodeKey !== undefined) return inodeKey;
  return yield* fileSystem
    .realPath(directory)
    .pipe(Effect.orElseSucceed(() => context.path.resolve(directory)));
});

const isNonSymlinkDirectory = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const isSymlink = yield* fileSystem.readLink(path).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (isSymlink) return false;
  return yield* fileSystem.stat(path).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
});

const readSubdirectories = Effect.fnUntraced(function* (
  base: string,
  context: BrowserImportPathContext,
  maxEntries?: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(base)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const dirs: Array<{ readonly name: string; readonly fullPath: string }> = [];
  for (const entry of entries) {
    if (shouldSkipDirectoryName(entry)) continue;
    const fullPath = context.path.join(base, entry);
    if (yield* isNonSymlinkDirectory(fullPath)) {
      dirs.push({ name: entry, fullPath });
      if (maxEntries !== undefined && dirs.length > maxEntries) return undefined;
    }
  }
  return dirs;
});

type RootDetection = "chromium" | "firefox" | "terminal" | undefined;

const detectBrowserEngineAtRoot = Effect.fnUntraced(function* (
  root: string,
  context: BrowserImportPathContext,
): Effect.fn.Return<RootDetection, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  let sawMarker = false;

  const profilesIniPath = yield* resolveFileWithinRoot(
    root,
    context.path.join(root, "profiles.ini"),
    context,
    false,
  );
  if (profilesIniPath !== undefined) {
    sawMarker = true;
    const ini = yield* fileSystem
      .readFileString(profilesIniPath)
      .pipe(Effect.orElseSucceed(() => ""));
    for (const profile of parseFirefoxProfiles(ini, context.path, root, false)) {
      const profilePath = context.path.isAbsolute(profile.directory)
        ? profile.directory
        : context.path.join(root, profile.directory);
      if (
        (yield* resolveFileWithinRoot(
          root,
          context.path.join(profilePath, "cookies.sqlite"),
          context,
          false,
        )) !== undefined
      ) {
        return "firefox";
      }
    }
    const fallbackDir = context.platform === "linux" ? root : context.path.join(root, "Profiles");
    const fallbackEntries = yield* fileSystem
      .readDirectory(fallbackDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    for (const entry of fallbackEntries) {
      if (
        (yield* resolveFileWithinRoot(
          root,
          context.path.join(fallbackDir, entry, "cookies.sqlite"),
          context,
          false,
        )) !== undefined
      ) {
        return "firefox";
      }
    }
  }

  // Require `Local State` with `profile.info_cache` so Electron apps are excluded.
  const localStatePath = yield* resolveFileWithinRoot(
    root,
    context.path.join(root, "Local State"),
    context,
    false,
  );
  if (localStatePath !== undefined) {
    sawMarker = true;
    const contents = yield* fileSystem
      .readFileString(localStatePath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (context.platform === "win32") {
      const dpapiSupported = yield* decodeWindowsWrappedKey(contents).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!dpapiSupported) return "terminal";
    }
    const profileDirs = yield* decodeLocalState(contents).pipe(
      Effect.map((state) =>
        Object.keys(state.profile?.info_cache ?? {}).filter(isSafeProfileDirectory),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );
    for (const dir of profileDirs) {
      if (
        (yield* resolveFileWithinRoot(
          root,
          context.path.join(root, dir, "Network", "Cookies"),
          context,
          false,
        )) !== undefined ||
        (yield* resolveFileWithinRoot(
          root,
          context.path.join(root, dir, "Cookies"),
          context,
          false,
        )) !== undefined
      ) {
        return "chromium";
      }
    }
  }

  return sawMarker ? "terminal" : undefined;
});

interface DiscoveredCandidate {
  readonly engine: "chromium" | "firefox";
  readonly root: string;
  readonly segments: ReadonlyArray<string>;
}

const scanBaseDirectory = Effect.fnUntraced(function* (
  base: string,
  context: BrowserImportPathContext,
  knownRoots: ReadonlySet<string>,
  seenRoots: Set<string>,
  options: {
    readonly allowChromium: boolean;
    readonly allowFirefox: boolean;
    readonly checkWindowsUserData?: boolean;
  },
): Effect.fn.Return<ReadonlyArray<DiscoveredCandidate>, never, FileSystem.FileSystem> {
  const candidates: Array<DiscoveredCandidate> = [];

  const tryRoot = Effect.fnUntraced(function* (
    root: string,
    segments: ReadonlyArray<string>,
  ): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
    const key = yield* rootDedupeKey(context, root);
    if (knownRoots.has(key) || seenRoots.has(key)) return true;
    const detected = yield* detectBrowserEngineAtRoot(root, context);
    if (detected === undefined) return false;
    if (detected === "terminal") return true;
    seenRoots.add(key);
    if (
      (detected === "chromium" && options.allowChromium) ||
      (detected === "firefox" && options.allowFirefox)
    ) {
      const fileSystem = yield* FileSystem.FileSystem;
      const canonicalRoot = yield* fileSystem
        .realPath(root)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (canonicalRoot !== undefined) {
        candidates.push({ engine: detected, root: canonicalRoot, segments });
      }
    }
    return true;
  });

  const level1 = (yield* readSubdirectories(base, context)) ?? [];
  for (const dir1 of level1) {
    if (yield* tryRoot(dir1.fullPath, [dir1.name])) continue;
    const level2 = yield* readSubdirectories(dir1.fullPath, context, MAX_NESTED_SCAN_ENTRIES);
    if (level2 === undefined) continue;
    for (const dir2 of level2) {
      if (yield* tryRoot(dir2.fullPath, [dir1.name, dir2.name])) continue;
      if (options.checkWindowsUserData) {
        const userData = context.path.join(dir2.fullPath, "User Data");
        if (yield* isNonSymlinkDirectory(userData)) {
          yield* tryRoot(userData, [dir1.name, dir2.name, "User Data"]);
        }
      }
    }
  }
  return candidates;
});

/** Return known sources followed by scanned Chromium and Firefox-based browsers. */
export const discoverBrowserImportSources = Effect.fn(
  "BrowserImportSources.discoverBrowserImportSources",
)(function* (
  context: BrowserImportPathContext,
): Effect.fn.Return<
  ReadonlyArray<BrowserImportSourceDefinition>,
  never,
  FileSystem.FileSystem | Digest.Digest
> {
  const crypto = yield* Digest.Digest;
  const knownRoots = new Set<string>();
  for (const source of BROWSER_IMPORT_SOURCES) {
    const root = source.userDataDirectory(context);
    if (root !== undefined) knownRoots.add(yield* rootDedupeKey(context, root));
    if (context.platform === "linux" && source.alternateLinuxRoots) {
      for (const alt of source.alternateLinuxRoots(context)) {
        knownRoots.add(yield* rootDedupeKey(context, alt));
      }
    }
  }
  // Avoid duplicating Ardia's legacy macOS folder when the primary `com.ardia.browser` install exists.
  const ardiaSource = BROWSER_IMPORT_SOURCES.find((source) => source.id === "ardia");
  if (
    context.platform === "darwin" &&
    context.home &&
    ardiaSource !== undefined &&
    (yield* isSourceInstalled(ardiaSource, context))
  ) {
    knownRoots.add(
      yield* rootDedupeKey(context, macApplicationSupport(context, "Ardia", "Chromium")),
    );
  }

  const seenRoots = new Set<string>();
  const rawCandidates: Array<DiscoveredCandidate> = [];

  if (context.platform === "darwin" && context.home) {
    rawCandidates.push(
      ...(yield* scanBaseDirectory(macApplicationSupport(context), context, knownRoots, seenRoots, {
        allowChromium: true,
        allowFirefox: true,
      })),
    );
  } else if (context.platform === "linux") {
    const configBases = new Set([context.linuxConfigHome, context.linuxChromeConfigHome]);
    for (const base of configBases) {
      if (!base) continue;
      rawCandidates.push(
        ...(yield* scanBaseDirectory(base, context, knownRoots, seenRoots, {
          allowChromium: true,
          allowFirefox: true,
        })),
      );
    }
    if (context.home) {
      rawCandidates.push(
        ...(yield* scanBaseDirectory(
          context.path.join(context.home, ".mozilla"),
          context,
          knownRoots,
          seenRoots,
          { allowChromium: false, allowFirefox: true },
        )),
      );
    }
  } else if (context.platform === "win32") {
    if (context.appData) {
      rawCandidates.push(
        ...(yield* scanBaseDirectory(context.appData, context, knownRoots, seenRoots, {
          allowChromium: false,
          allowFirefox: true,
        })),
      );
    }
    if (context.localAppData) {
      rawCandidates.push(
        ...(yield* scanBaseDirectory(context.localAppData, context, knownRoots, seenRoots, {
          allowChromium: true,
          allowFirefox: false,
          checkWindowsUserData: true,
        })),
      );
    }
  }

  const discovered: Array<BrowserImportSourceDefinition> = [];
  for (const candidate of rawCandidates) {
    const name = deriveDiscoveredBrowserName(candidate.segments);
    if (name === undefined) continue;
    const canonicalRoot = candidate.root;
    const hashed = yield* crypto
      .digest(Digest.sha256, new TextEncoder().encode(`${candidate.engine}\0${canonicalRoot}`))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (hashed === undefined) continue;
    const id: BrowserImportSourceId = `discovered:${candidate.engine}:${Hex.encode(hashed).slice(0, 16)}`;
    if (candidate.engine === "firefox") {
      discovered.push({
        id,
        name,
        engine: "firefox",
        platforms: [context.platform],
        userDataDirectory: () => canonicalRoot,
      });
    } else {
      const keychainCandidates = discoveredChromiumKeychainCandidates(name);
      const linuxSecretApplications = discoveredLinuxSecretApplications(candidate.segments, name);
      discovered.push({
        id,
        name,
        engine: "chromium",
        platforms: [context.platform],
        userDataDirectory: () => canonicalRoot,
        ...(keychainCandidates[0]
          ? {
              keychainService: keychainCandidates[0].service,
              keychainAccount: keychainCandidates[0].account,
            }
          : {}),
        keychainCandidates,
        ...(linuxSecretApplications[0]
          ? { linuxSecretApplication: linuxSecretApplications[0] }
          : {}),
        linuxSecretApplications,
      });
    }
  }

  discovered.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  return [...BROWSER_IMPORT_SOURCES, ...discovered];
});

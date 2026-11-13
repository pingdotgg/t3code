// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { ShellEnvironmentPatch } from "@t3tools/contracts";
import * as HostProcess from "./HostProcess.ts";
import * as Context from "effect/Context";
import type { ResolvedSpawnCommand } from "./shellPart2.ts";
import { COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR, COMMAND_RESOLUTION_CACHE_MAX_ENTRIES, COMMAND_RESOLUTION_CACHE_TTL_NANOS, WINDOWS_PATH_DELIMITER, canExecuteFile, escapeWindowsShellArg, mergePathValues, pathDelimiterForPlatform, readEnvPath, readEnvironmentFromWindowsShell, resolveCommandCandidates, resolvePathEnvironmentVariable, resolveSpawnExecutableWithNode, resolveWindowsPathExtensions, stripWrappingQuotes } from "./shellPart2.ts";
export type {
  ResolvedSpawnCommand,
  ShellEnvironmentReader,
} from "./shellPart2.ts";
export {
  buildEnvironmentCaptureCommand,
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  readEnvironmentFromLoginShell,
  readEnvironmentFromWindowsShell,
  readPathFromLaunchctl,
} from "./shellPart2.ts";

export interface CommandAvailabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

export type CommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>;

export type SpawnExecutableResolver = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined;

export const SpawnExecutableResolution = Context.Reference<SpawnExecutableResolver>(
  "@t3tools/shared/shell/SpawnExecutableResolution",
  {
    defaultValue: () => resolveSpawnExecutableWithNode,
  },
);

export interface WindowsEnvironmentProbeOptions {
  readonly loadProfile?: boolean;
}

export type WindowsShellEnvironmentReader = (
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
) => Effect.Effect<Partial<Record<string, string>>>;

export const WindowsShellEnvironment = Context.Reference<WindowsShellEnvironmentReader>(
  "@t3tools/shared/shell/WindowsShellEnvironment",
  {
    defaultValue: () => readEnvironmentFromWindowsShell,
  },
);

export const CommandAvailability = Context.Reference<CommandAvailabilityChecker>(
  "@t3tools/shared/shell/CommandAvailability",
  {
    defaultValue: () => isCommandAvailable,
  },
);

interface CommandResolutionCacheEntry {
  readonly resolvedPath: string | null;
  readonly expiresAtNanos: bigint;
}

export const CommandResolutionCache = Context.Reference<Map<string, CommandResolutionCacheEntry>>(
  "@t3tools/shared/shell/CommandResolutionCache",
  {
    defaultValue: () => new Map(),
  },
);

interface PathDirectoryListing {
  readonly modified: number | null | undefined;
  readonly names: ReadonlySet<string> | undefined;
}

const directoryMtime = (directory: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.stat(directory)).pipe(
    Effect.map((info) =>
      info.type === "Directory" ? Option.getOrUndefined(info.mtime)?.getTime() : undefined,
    ),
    Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? null : undefined)),
  );

// Timestamp before reading so concurrent additions change the next mtime check; missing listings fall back to direct probes.
const listPathDirectory = Effect.fnUntraced(function* (
  directory: string,
): Effect.fn.Return<PathDirectoryListing, never, FileSystem.FileSystem> {
  const modified = yield* directoryMtime(directory);
  if (modified == null) return { modified, names: modified === null ? new Set() : undefined };
  const entries = yield* FileSystem.FileSystem.use((fileSystem) =>
    fileSystem.readDirectory(directory),
  ).pipe(Effect.orElseSucceed(() => undefined));
  return { modified, names: entries && new Set(entries.map((entry) => entry.toLowerCase())) };
});

const PathDirectoryListings = Context.Reference<
  Cache.Cache<string, PathDirectoryListing, never, FileSystem.FileSystem> | undefined
>("@t3tools/shared/shell/PathDirectoryListings", { defaultValue: () => undefined });

export const withPathDirectoryListings =
  /* Directory reads are cached inside one shell operation; a span for each lookup adds noise. */
  Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    const listings = yield* Cache.make({
      capacity: 1024,
      lookup: listPathDirectory,
      requireServicesAt: "lookup",
    });
    return yield* effect.pipe(Effect.provideService(PathDirectoryListings, listings));
  });

// An injected resolver or locator may answer differently for the same search, so its
// entries are kept apart from every other resolver's.
let spawnResolverCacheIdCount = 0;

const spawnResolverCacheIds = new WeakMap<SpawnExecutableResolver | XcodeGitLocator, number>();

function spawnResolverCacheId(resolver: SpawnExecutableResolver | XcodeGitLocator): number {
  const known = spawnResolverCacheIds.get(resolver);
  if (known !== undefined) return known;
  const id = spawnResolverCacheIdCount++;
  spawnResolverCacheIds.set(resolver, id);
  return id;
}

function cacheCommandResolution(
  cache: Map<string, CommandResolutionCacheEntry>,
  cacheKey: string,
  resolvedPath: string | null,
  nowNanos: bigint,
): void {
  if (cache.size >= COMMAND_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(cacheKey, {
    resolvedPath,
    expiresAtNanos: nowNanos + COMMAND_RESOLUTION_CACHE_TTL_NANOS,
  });
}

const isExecutableFile = Effect.fnUntraced(function* (
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (stat === null || stat.type !== "File") return false;

  if (platform === "win32") {
    const extension = path.extname(filePath);
    if (extension.length === 0) return false;
    return windowsPathExtensions.includes(extension.toUpperCase());
  }

  return canExecuteFile(filePath);
});

const resolveCommandPathForPlatform = Effect.fn("shell.resolveCommandPathForPlatform")(function* (
  command: string,
  options: CommandAvailabilityOptions & { readonly platform: NodeJS.Platform },
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const platform = options.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of commandCandidates) {
      if (yield* isExecutableFile(candidate, platform, windowsPathExtensions)) {
        return candidate;
      }
    }
    return null;
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) {
    return null;
  }

  const cacheKey = [platform, pathValue, windowsPathExtensions.join(";"), command].join(
    COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR,
  );
  const cache = yield* CommandResolutionCache;
  const nowNanos = yield* Clock.monotonicTimeNanos;
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    return cached.resolvedPath;
  }

  // Keep case variants: Windows can make PATH directories case-sensitive.
  const pathEntries: string[] = [];
  const seenPathEntries = new Set<string>();
  for (const entry of pathValue.split(pathDelimiterForPlatform(platform))) {
    const pathEntry = stripWrappingQuotes(entry.trim());
    if (pathEntry.length === 0 || seenPathEntries.has(pathEntry)) continue;

    seenPathEntries.add(pathEntry);
    pathEntries.push(pathEntry);
  }

  const listings = yield* PathDirectoryListings;
  for (const pathEntry of pathEntries) {
    let listing = listings && (yield* Cache.get(listings, pathEntry));
    if (listings && listing?.names && listing.modified !== (yield* directoryMtime(pathEntry))) {
      yield* Cache.invalidate(listings, pathEntry);
      listing = yield* Cache.get(listings, pathEntry);
    }
    for (const candidate of commandCandidates) {
      if (listing?.names && !listing.names.has(candidate.toLowerCase())) continue;
      const candidatePath = path.join(pathEntry, candidate);
      if (yield* isExecutableFile(candidatePath, platform, windowsPathExtensions)) {
        cacheCommandResolution(cache, cacheKey, candidatePath, nowNanos);
        return candidatePath;
      }
    }
  }
  cacheCommandResolution(cache, cacheKey, null, nowNanos);
  return null;
});

export const resolveCommandPath = Effect.fn("shell.resolveCommandPath")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return yield* resolveCommandPathForPlatform(command, {
    env: options.env ?? (yield* HostProcess.Environment),
    platform: yield* HostProcess.Platform,
  });
});

// Git 2.56 x64 uses ucrt64; ARM64 uses clangarm64; older x64/32-bit builds use mingw64/mingw32.
const GIT_FOR_WINDOWS_BUILDS = ["ucrt64", "clangarm64", "mingw64", "mingw32"] as const;

function isFileSync(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Bypass the launcher's extra process and kernel-token leak. Retain it when MSYSTEM is set, or git.exe omits hook/helper PATH entries. */
export function preferGitForWindowsBinary(
  executable: string,
  env: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean = isFileSync,
): string {
  if (env.MSYSTEM) return executable;
  const path = NodePath.win32;
  if (path.basename(executable).toLowerCase() !== "git.exe") return executable;
  const launcherDirectory = path.dirname(executable);
  const launcherFolder = path.basename(launcherDirectory).toLowerCase();
  if (launcherFolder !== "cmd" && launcherFolder !== "bin") return executable;
  const installRoot = path.dirname(launcherDirectory);
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = path.join(installRoot, build, "bin", "git.exe");
    if (isFile(candidate)) return candidate;
  }
  return executable;
}

// npm cmd-shim format for native executables.
const NPM_EXECUTABLE_SHIM_PREFIX = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
];

const NPM_EXECUTABLE_SHIM_RUN = /^"%dp0%\\([^"%]+\.exe)" +%\*$/;

function readFileSyncOrUndefined(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolve shims that only launch native executables so direct spawning keeps them in libuv's kill-on-close job. */
export function npmShimExecutable(
  shimPath: string,
  readFile: (filePath: string) => string | undefined = readFileSyncOrUndefined,
  isFile: (filePath: string) => boolean = isFileSync,
): string | undefined {
  const path = NodePath.win32;
  if (path.extname(shimPath).toLowerCase() !== ".cmd") return undefined;
  // Match exactly because preserved SET whitespace can select a different file.
  const lines = readFile(shimPath)
    ?.split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines?.length !== NPM_EXECUTABLE_SHIM_PREFIX.length + 1) return undefined;
  if (NPM_EXECUTABLE_SHIM_PREFIX.some((expected, index) => lines[index] !== expected)) {
    return undefined;
  }
  const target = NPM_EXECUTABLE_SHIM_RUN.exec(lines.at(-1)!)?.[1];
  if (target === undefined) return undefined;
  const executable = path.join(path.dirname(shimPath), target);
  return isFile(executable) ? executable : undefined;
}

export type XcodeGitLocator = (env: NodeJS.ProcessEnv) => string | undefined;

// xcrun honors DEVELOPER_DIR and the `xcode-select` choice, as the shim does.
function locateXcodeGitWithXcrun(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const located = NodeChildProcess.execFileSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return NodePath.isAbsolute(located) ? located : undefined;
  } catch {
    return undefined;
  }
}

export const XcodeGitLocation = Context.Reference<XcodeGitLocator>(
  "@t3tools/shared/shell/XcodeGitLocation",
  { defaultValue: () => locateXcodeGitWithXcrun },
);

const MACOS_GIT_SHIM = "/usr/bin/git";

/**
 * Skip the xcrun shim's per-spawn lookup only when git resolves to /usr/bin/git.
 * User-selected git on PATH still wins, children keep PATH, and lookup failures use `git`.
 */
const resolveMacosGit = Effect.fnUntraced(function* (
  env: NodeJS.ProcessEnv,
  resolveExecutable: SpawnExecutableResolver,
) {
  const locateXcodeGit = yield* XcodeGitLocation;
  const cache = yield* CommandResolutionCache;
  const cacheKey = [
    "xcode-git",
    String(spawnResolverCacheId(resolveExecutable)),
    String(spawnResolverCacheId(locateXcodeGit)),
    resolvePathEnvironmentVariable(env),
    env.DEVELOPER_DIR ?? "",
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = cache.get(cacheKey);
  // An Xcode update or removal deletes the binary; look again instead of failing the spawn.
  if (
    cached !== undefined &&
    cached.expiresAtNanos > nowNanos &&
    (cached.resolvedPath === null ||
      resolveExecutable(cached.resolvedPath, "darwin", env) !== undefined)
  ) {
    return cached.resolvedPath ?? "git";
  }
  const located =
    resolveExecutable("git", "darwin", env) === MACOS_GIT_SHIM ? locateXcodeGit(env) : undefined;
  const realGit =
    located !== undefined && resolveExecutable(located, "darwin", env) !== undefined
      ? located
      : null;
  cacheCommandResolution(cache, cacheKey, realGit, nowNanos);
  return realGit ?? "git";
});

export interface SpawnCommandOptions extends CommandAvailabilityOptions {
  /** Bypass npm cmd-shims; see npmShimExecutable for process-lifetime semantics. */
  readonly bypassNpmShim?: boolean;
}

export const resolveSpawnCommand = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnCommandOptions = {},
): Effect.fn.Return<ResolvedSpawnCommand> {
  const platform = yield* HostProcess.Platform;
  const isMacosGit = platform === "darwin" && command === "git";
  if (platform !== "win32" && !isMacosGit) {
    return { command, args: [...args], shell: false };
  }

  const hostEnvironment = yield* HostProcess.Environment;
  const env =
    options.env === undefined
      ? hostEnvironment
      : options.extendEnv
        ? { ...hostEnvironment, ...options.env }
        : options.env;
  const resolveExecutable = yield* SpawnExecutableResolution;
  if (isMacosGit) {
    return {
      command: yield* resolveMacosGit(env, resolveExecutable),
      args: [...args],
      shell: false,
    };
  }
  // The scan is synchronous and runs before every child process, so it shares
  // the PATH scan cache above. Explicit paths stay uncached for the same reason,
  // and so do misses: a failed spawn is how providers report "not installed",
  // and that has to clear the moment the binary appears.
  const explicitPath = command.includes("/") || command.includes("\\");
  const cache = yield* CommandResolutionCache;
  const cacheKey = [
    "spawn",
    String(spawnResolverCacheId(resolveExecutable)),
    platform,
    resolvePathEnvironmentVariable(env),
    resolveWindowsPathExtensions(env).join(";"),
    env.MSYSTEM ? "msystem" : "",
    command,
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = explicitPath ? undefined : cache.get(cacheKey);
  let resolvedExecutable: string | null;
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    resolvedExecutable = cached.resolvedPath;
  } else {
    const found = resolveExecutable(command, platform, env);
    resolvedExecutable = found === undefined ? null : preferGitForWindowsBinary(found, env);
    if (!explicitPath && resolvedExecutable !== null) {
      cacheCommandResolution(cache, cacheKey, resolvedExecutable, nowNanos);
    }
  }
  const resolvedCommand = resolvedExecutable ?? command;
  const extension = NodePath.win32.extname(resolvedCommand).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolvedCommand, args: [...args], shell: false };
  }
  const shimExecutable = options.bypassNpmShim ? npmShimExecutable(resolvedCommand) : undefined;
  if (shimExecutable !== undefined) {
    return { command: shimExecutable, args: [...args], shell: false };
  }

  // Build the escaped command line without separate args to avoid Node DEP0190 with shell:true.
  return {
    command: [resolvedCommand, ...args].map(escapeWindowsShellArg).join(" "),
    args: [],
    shell: true,
  };
});

export const isCommandAvailable = Effect.fn("shell.isCommandAvailable")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return (yield* resolveCommandPath(command, options)) !== null;
});

function resolveKnownWindowsCliDirs(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();

  return [
    ...(appData ? [`${appData}\\npm`] : []),
    ...(localAppData ? [`${localAppData}\\Programs\\nodejs`, `${localAppData}\\Volta\\bin`] : []),
    ...(localAppData ? [`${localAppData}\\pnpm`] : []),
    ...(userProfile
      ? [`${userProfile}\\.local\\bin`, `${userProfile}\\.bun\\bin`, `${userProfile}\\scoop\\shims`]
      : []),
  ];
}

/** Keep one PATH spelling in copied Windows environment records. */
export function setWindowsPath(env: NodeJS.ProcessEnv, value: string | null): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") {
      delete env[key];
    }
  }
  if (value !== null) env.PATH = value;
}

function mergeWindowsEnv(
  currentEnv: NodeJS.ProcessEnv,
  patch: Partial<Record<string, string>>,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...currentEnv };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "PATH") {
      setWindowsPath(nextEnv, value);
    } else {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

export const resolveWindowsEnvironment = Effect.fn("shell.resolveWindowsEnvironment")(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Partial<NodeJS.ProcessEnv>, never, FileSystem.FileSystem | Path.Path> {
  const readEnvironment = yield* WindowsShellEnvironment;
  const commandAvailable = yield* CommandAvailability;
  const inheritedPath = readEnvPath(env);
  const shellPath = (yield* readEnvironment(["PATH"], { loadProfile: false })).PATH;
  const mergedPath = mergePathValues(shellPath, inheritedPath, "win32");
  const knownCliPath = resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER);
  const baselinePath = mergePathValues(mergedPath, knownCliPath, "win32");
  const baselinePatch: Partial<NodeJS.ProcessEnv> = baselinePath ? { PATH: baselinePath } : {};
  const baselineEnv = mergeWindowsEnv(env, baselinePatch);

  if (yield* commandAvailable("node", { env: baselineEnv })) {
    return baselinePatch;
  }

  const profiledEnvironment = yield* readEnvironment(["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"], {
    loadProfile: true,
  });
  const profiledPath = mergePathValues(profiledEnvironment.PATH, baselinePath, "win32");
  const profiledPatch: Partial<NodeJS.ProcessEnv> = {
    ...(profiledPath ? { PATH: profiledPath } : {}),
    ...(profiledEnvironment.FNM_DIR ? { FNM_DIR: profiledEnvironment.FNM_DIR } : {}),
    ...(profiledEnvironment.FNM_MULTISHELL_PATH
      ? { FNM_MULTISHELL_PATH: profiledEnvironment.FNM_MULTISHELL_PATH }
      : {}),
  };
  return Object.keys(profiledPatch).length > 0
    ? { ...baselinePatch, ...profiledPatch }
    : baselinePatch;
});

export function applyShellEnvironment(
  env: NodeJS.ProcessEnv,
  patch: ShellEnvironmentPatch,
  platform: NodeJS.Platform,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "PATH" && platform === "win32") setWindowsPath(env, value);
    else if (value === null) delete env[key];
    else env[key] = value;
  }
}

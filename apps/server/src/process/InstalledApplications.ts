/**
 * InstalledApplications - discovers applications installed on this host.
 *
 * Backs the "Open with" list: a read-only scan of the platform's application
 * registry, so the user picks a program by name instead of hunting for its
 * executable. Scanning runs on the environment host, which is the machine that
 * will actually run the command, so it works the same for local and remote
 * clients.
 *
 * @module InstalledApplications
 */
import type { InstalledApplication } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as NodeOS from "node:os";
import {
  finalizeInstalledApplications,
  isRememberableApplication,
  parseDesktopEntry,
  parseMacApplicationBundleName,
} from "./installedApplicationParsing.ts";

/**
 * A scan walks a handful of directories and, on Linux, reads every entry. That
 * is cheap but not free, so the result is memoized briefly: opening the picker
 * twice in a row must not rescan, while installing an app and reopening it
 * within the same session still shows the new entry.
 */
const SCAN_CACHE_TTL_NANOS = 30_000_000_000n;

/** Bound the list so a pathological host cannot flood the client. */
const MAX_APPLICATIONS = 500;

type DiscoveredEntry = Omit<InstalledApplication, "id">;

interface ScanCacheEntry {
  readonly applications: ReadonlyArray<InstalledApplication>;
  readonly expiresAtNanos: bigint;
}

/**
 * Reads a directory, treating an unreadable one as empty: application
 * directories are frequently absent or permission-restricted, and a partial
 * list is far more useful than a failed scan.
 */
const readDirectoryOrEmpty = Effect.fn("installedApplications.readDirectoryOrEmpty")(function* (
  directory: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
});

const scanLinux = Effect.fn("installedApplications.scanLinux")(function* (
  home: string,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<DiscoveredEntry>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Honor XDG_DATA_DIRS/XDG_DATA_HOME so Flatpak, Snap, and Nix installs are
  // found, falling back to the spec's defaults when they are unset.
  // `||` rather than `??`: an empty XDG variable means "unset" in practice, and
  // `??` would treat it as configured, dropping the system application
  // directories and resolving the home path relative to the cwd.
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter((entry) => entry.length > 0);
  const directories = [dataHome, ...dataDirs].map((base) => path.join(base, "applications"));

  const entries: DiscoveredEntry[] = [];
  for (const directory of directories) {
    for (const fileName of yield* readDirectoryOrEmpty(directory)) {
      if (!fileName.endsWith(".desktop")) continue;
      const contents = yield* fileSystem
        .readFileString(path.join(directory, fileName))
        .pipe(Effect.orElseSucceed(() => ""));
      if (contents.length === 0) continue;
      const parsed = parseDesktopEntry(contents);
      if (parsed !== null) entries.push(parsed);
    }
  }
  return entries;
});

const scanMac = Effect.fn("installedApplications.scanMac")(function* (
  home: string,
): Effect.fn.Return<ReadonlyArray<DiscoveredEntry>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const directories = [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    path.join(home, "Applications"),
  ];

  const entries: DiscoveredEntry[] = [];
  for (const directory of directories) {
    for (const fileName of yield* readDirectoryOrEmpty(directory)) {
      const name = parseMacApplicationBundleName(fileName);
      if (name === null) continue;
      // `open -a <bundle>` is the supported way to hand a path to a bundle;
      // reaching into Contents/MacOS bypasses the app's own launch handling.
      entries.push({ name, command: "open", args: ["-a", path.join(directory, fileName)] });
    }
  }
  return entries;
});

/**
 * Windows discovery is deliberately not implemented.
 *
 * Start Menu entries are `.lnk` shortcuts, and `explorer <shortcut>` does not
 * forward extra arguments to the shortcut's target, so an application found
 * that way would launch without the project path. Listing them anyway would
 * put entries in the Open menu that quietly do the wrong thing.
 *
 * Doing this properly means resolving each shortcut's target and arguments,
 * which needs a shell round trip the rest of this scan does not take. Until
 * that exists, Windows hosts offer the built-in editors only.
 */
const scanWindows: Effect.Effect<ReadonlyArray<DiscoveredEntry>> = Effect.succeed([]);

/**
 * InstalledApplications - Service tag for host application discovery.
 */
export class InstalledApplications extends Context.Service<
  InstalledApplications,
  {
    /** Applications installed on this host, sorted by display name. */
    readonly list: Effect.Effect<ReadonlyArray<InstalledApplication>>;
  }
>()("t3/process/InstalledApplications") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  const scan = Effect.gen(function* () {
    const home = env.HOME ?? env.USERPROFILE ?? NodeOS.homedir();
    const entries =
      platform === "darwin"
        ? yield* scanMac(home)
        : platform === "win32"
          ? yield* scanWindows
          : yield* scanLinux(home, env);
    // Filter before capping so an application that could never be stored does
    // not consume one of the slots.
    return finalizeInstalledApplications(entries)
      .filter(isRememberableApplication)
      .slice(0, MAX_APPLICATIONS);
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    // A scan touches only the filesystem and cannot fail; a defect here would
    // still be a bug, so it is not swallowed.
    Effect.withSpan("installedApplications.scan"),
  );

  // Deliberately not `Effect.cachedWithTTL`, for the same reason as the editor
  // discovery cache in externalLauncher.ts: it memoizes the first caller's Exit
  // including an interrupt, and this runs on a connection fiber that a client
  // can drop mid-scan. Storing only on success means an interrupted scan leaves
  // the cache untouched and the next request simply rescans. Expiry uses the
  // monotonic clock so a backward wall-clock change cannot extend an entry.
  const cache = yield* Ref.make<Option.Option<ScanCacheEntry>>(Option.none());
  const cachedScan = Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos;
    const entry = yield* Ref.get(cache);
    if (Option.isSome(entry) && entry.value.expiresAtNanos > nowNanos) {
      return entry.value.applications;
    }
    const applications = yield* scan;
    yield* Ref.set(
      cache,
      Option.some({
        applications,
        expiresAtNanos: nowNanos + SCAN_CACHE_TTL_NANOS,
      }),
    );
    return applications;
  });

  return InstalledApplications.of({ list: cachedScan });
});

export const layer = Layer.effect(InstalledApplications, make);

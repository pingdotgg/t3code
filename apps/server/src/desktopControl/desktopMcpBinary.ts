import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  desktopMcpPathOverride,
  MUNIM_COMPUTER_USE_RESOURCE_DIR,
  munimComputerUseAssetKey,
  munimComputerUseCacheDir,
  munimComputerUseCheckoutBinaries,
  munimComputerUseExecutableName,
  parseMunimComputerUseManifest,
  type MunimComputerUsePlatform,
} from "@t3tools/shared/munimComputerUse";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class MunimComputerUseManifestError extends Schema.TaggedError<MunimComputerUseManifestError>()(
  "MunimComputerUseManifestError",
  { cause: Schema.Defect() },
) {}

/**
 * Locate the desktop-control MCP server: the munim-computer-use binary, run by
 * MT Code under its own identity and registered as `mt-desktop`.
 *
 * Order: `MTCODE_DESKTOP_MCP_PATH` (then the deprecated `T3CODE_DESKTOP_MCP_PATH`),
 * the copy packaged into the app's Resources, a local munim-computer-use
 * checkout's build (`$MUNIM_COMPUTER_USE_CHECKOUT`, default `~/computer-use`),
 * the release the desktop build fetched into the cache for the version pinned
 * in `native/munim-computer-use.json`, and finally the newest release the
 * standalone `npx munim-computer-use` launcher cached (how an SSH host, which
 * runs a bare server with no app bundle, gets one). Resolves to undefined
 * when none exists — callers treat that as "do not offer the tools", which
 * also hides Computer View for the machine.
 */
export const resolveDesktopMcpPath = Effect.fn("desktopControl.resolveDesktopMcpPath")(
  function* () {
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      return undefined;
    }

    const environment = yield* HostProcess.Environment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executableName = munimComputerUseExecutableName(platform);

    const override = desktopMcpPathOverride(environment);

    const packaged = packagedDesktopMcpCandidates({
      moduleDir: import.meta.dirname,
      executableName,
      path,
    });

    const home = environment.HOME ?? environment.USERPROFILE;
    const checkout =
      environment.MUNIM_COMPUTER_USE_CHECKOUT?.trim() ||
      (home ? path.join(home, "computer-use") : undefined);
    const checkoutBuilds = checkout
      ? munimComputerUseCheckoutBinaries(platform).map((parts) => path.join(checkout, ...parts))
      : [];

    const cached = yield* fetchedReleaseBinary({ platform, environment, home, path, fileSystem });

    const standalone = yield* standaloneReleaseBinary({
      platform,
      environment,
      home,
      path,
      fileSystem,
    });

    const candidates = [
      ...(override ? [override] : []),
      ...packaged,
      ...checkoutBuilds,
      ...(cached ? [cached] : []),
      ...(standalone ? [standalone] : []),
    ];

    for (const candidate of candidates) {
      if (yield* isRunnable(fileSystem, platform, candidate)) {
        return candidate;
      }
    }
    return undefined;
  },
);

/**
 * Where a packaged app keeps the binary, given the directory of the server
 * module doing the lookup.
 *
 * The desktop build stages it at `<resources>/munim-computer-use`, while the
 * server bundle runs from inside an archive in that same directory:
 * `Resources/app.asar/apps/server/dist` on macOS and Linux,
 * `resources\server.asar\apps\server\dist` on Windows. So the copy sits
 * beside the archive, not beside the module. Looking only next to the module
 * missed it on every installed app: the server never advertised Computer View
 * or the agent desktop tools unless a `~/computer-use` checkout happened to be
 * built on that machine (true on the Mac that builds MT Code, false on the
 * Windows laptop).
 */
export function packagedDesktopMcpCandidates(input: {
  readonly moduleDir: string;
  readonly executableName: string;
  readonly path: Pick<Path.Path, "resolve" | "dirname" | "basename">;
}): ReadonlyArray<string> {
  const { moduleDir, executableName, path } = input;
  const candidates = [
    path.resolve(moduleDir, MUNIM_COMPUTER_USE_RESOURCE_DIR, executableName),
    path.resolve(moduleDir, "..", MUNIM_COMPUTER_USE_RESOURCE_DIR, executableName),
  ];
  // Walk up to the archive the server bundle is packed in (app.asar,
  // server.asar, or their `.asar.unpacked` twins) and look in its directory.
  let current = path.resolve(moduleDir);
  for (;;) {
    const name = path.basename(current).toLowerCase();
    if (name.endsWith(".asar") || name.endsWith(".asar.unpacked")) {
      candidates.push(
        path.resolve(path.dirname(current), MUNIM_COMPUTER_USE_RESOURCE_DIR, executableName),
      );
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

/** Remote control (moving the real cursor) arrived in munim-computer-use 0.4.1. */
const MIN_STANDALONE_RELEASE: readonly [number, number, number] = [0, 4, 1];

function parseReleaseVersion(name: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareReleaseVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * The newest release directory the standalone launcher cached that is recent
 * enough to drive Computer View. Anything else in the cache (staging dirs,
 * pre-release names, older versions) is ignored.
 */
export function newestStandaloneRelease(names: ReadonlyArray<string>): string | undefined {
  let best: { readonly name: string; readonly version: readonly [number, number, number] } | null =
    null;
  for (const name of names) {
    const version = parseReleaseVersion(name);
    if (!version || compareReleaseVersions(version, MIN_STANDALONE_RELEASE) < 0) continue;
    if (best === null || compareReleaseVersions(version, best.version) > 0) {
      best = { name, version };
    }
  }
  return best?.name;
}

function standaloneCacheBase(
  platform: MunimComputerUsePlatform,
  environment: Readonly<Record<string, string | undefined>>,
  home: string | undefined,
  path: Path.Path,
): string | undefined {
  const explicit = environment.COMPUTER_USE_CACHE_DIR?.trim();
  if (explicit) return explicit;
  if (platform === "win32") {
    const root = environment.LOCALAPPDATA?.trim() || home;
    return root ? path.join(root, "munim-computer-use") : undefined;
  }
  const xdg = environment.XDG_CACHE_HOME?.trim();
  const root = xdg || (home ? path.join(home, ".cache") : undefined);
  return root ? path.join(root, "munim-computer-use") : undefined;
}

/**
 * The binary `npx munim-computer-use` downloaded, if any. Mirrors the
 * launcher's cache: `$COMPUTER_USE_CACHE_DIR`, else
 * `%LOCALAPPDATA%\munim-computer-use` on Windows and
 * `${XDG_CACHE_HOME:-~/.cache}/munim-computer-use` elsewhere, one directory per
 * version.
 */
const standaloneReleaseBinary = Effect.fn("desktopControl.standaloneReleaseBinary")(
  function* (input: {
    readonly platform: MunimComputerUsePlatform;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly home: string | undefined;
    readonly path: Path.Path;
    readonly fileSystem: FileSystem.FileSystem;
  }) {
    const { environment, path } = input;
    const base = standaloneCacheBase(input.platform, environment, input.home, path);
    if (base === undefined) return undefined;
    const names = yield* input.fileSystem
      .readDirectory(base)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const version = newestStandaloneRelease(names);
    if (version === undefined) return undefined;
    return path.join(base, version, munimComputerUseExecutableName(input.platform));
  },
);

/** The binary the desktop build fetched for the pinned release, if any (dev only). */
const fetchedReleaseBinary = Effect.fn("desktopControl.fetchedReleaseBinary")(function* (input: {
  readonly platform: MunimComputerUsePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string | undefined;
  readonly path: Path.Path;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  if (!input.home) return undefined;
  // Only a checkout has the manifest; a packaged server never reaches here.
  const manifestPath = input.path.resolve(
    import.meta.dirname,
    "../../../../native/munim-computer-use.json",
  );
  const text = yield* input.fileSystem
    .readFileString(manifestPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined) return undefined;
  const manifest = yield* Effect.try({
    try: () => parseMunimComputerUseManifest(text),
    catch: (cause) => new MunimComputerUseManifestError({ cause }),
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (manifest === undefined) return undefined;
  const version = manifest.version;
  const arch = yield* HostProcess.Architecture;
  const key = munimComputerUseAssetKey(input.platform, arch === "arm64" ? "arm64" : "x64");
  const dir = munimComputerUseCacheDir({
    environment: input.environment,
    homeDir: input.home,
    version,
    key,
    join: (...parts) => input.path.join(...parts),
  });
  return input.path.join(dir, munimComputerUseExecutableName(input.platform));
});

const isRunnable = Effect.fn("desktopControl.isRunnable")(function* (
  fileSystem: FileSystem.FileSystem,
  platform: MunimComputerUsePlatform,
  candidate: string,
) {
  const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
  if (Option.isNone(stat) || stat.value.type !== "File") return false;
  // Windows does not use POSIX execute bits the same way; existence of a
  // regular file is enough. On POSIX, skip non-executable paths so a bad
  // override does not block a valid packaged binary.
  return platform === "win32" || (stat.value.mode & 0o111) !== 0;
});

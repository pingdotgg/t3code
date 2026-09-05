import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const HOMEBREW_INFO_TIMEOUT_MS = 10_000;
const HOMEBREW_INFO_MAX_BYTES = 256 * 1_024;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

/**
 * Ownership is re-derived from the executable this often. Installs do not
 * move on their own, so this mostly bounds how stale a Homebrew "latest" can
 * get; the npm registry check keeps its own cache.
 */
export const MAINTENANCE_CAPABILITIES_CACHE_TTL = Duration.hours(1);

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * Latest version reported by the installer that owns the executable.
   * `undefined` means the installer has no channel of its own and the npm
   * registry entry for `packageName` is authoritative; `null` means the
   * installer was asked and did not know.
   */
  readonly latestVersion?: string | null;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /**
   * Extra environment for the spawned updater, on top of the server's own.
   * A native updater finds its install through the same variables the
   * provider runs with (e.g. `CODEX_HOME`), so an instance with a custom home
   * must update that home and not the default one.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** Where the provider executable was found; every path is absolute. */
export interface ProviderMaintenanceResolutionContext {
  readonly binaryPath: string;
  readonly resolvedCommandPath: string;
  readonly realCommandPath: string;
  readonly env: NodeJS.ProcessEnv;
  /** Host platform; decides how the copyable command quotes the executable. */
  readonly platform: NodeJS.Platform;
}

export type ProviderMaintenanceResolverServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    context: ProviderMaintenanceResolutionContext | null,
  ) => Effect.Effect<ProviderMaintenanceCapabilities, never, ProviderMaintenanceResolverServices>;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly nativeUpdate: {
    readonly args: ReadonlyArray<string>;
    readonly isCommandPath: (commandPath: string) => boolean;
    /** Environment the native updater needs to target this instance's install. */
    readonly env?: NodeJS.ProcessEnv;
  } | null;
}

export interface ProviderVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

export const ProviderVersionCache = Context.Reference<Map<string, ProviderVersionCacheEntry>>(
  "@t3tools/server/providerMaintenance/ProviderVersionCache",
  {
    defaultValue: () => new Map(),
  },
);
const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The copyable command must paste into a shell as-is, so an executable path
 * with spaces or quotes is quoted for the host's default shell.
 */
function quoteShellWord(word: string, platform: NodeJS.Platform): string {
  const safeWord = platform === "win32" ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/;
  if (safeWord.test(word)) return word;
  return platform === "win32"
    ? `'${word.replace(/['\u2018\u2019]/g, "$&$&")}'`
    : `'${word.replaceAll("'", "'\\''")}'`;
}

function quoteUpdateExecutable(executable: string, platform: NodeJS.Platform): string {
  const quoted = quoteShellWord(executable, platform);
  // Windows terminals default to PowerShell, where a quoted executable needs &.
  return platform === "win32" && quoted !== executable ? `& ${quoted}` : quoted;
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  /** Shown to the user instead of `<executable> <args>`; use for a bare tool name like `brew`. */
  readonly updateCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly latestVersion?: string | null;
}): ProviderMaintenanceCapabilities {
  const platform = input.platform ?? HostProcessPlatform.defaultValue();
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command:
            input.updateCommand ??
            [
              quoteUpdateExecutable(input.updateExecutable, platform),
              ...input.updateArgs.map((arg) => quoteShellWord(arg, platform)),
            ].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          ...(input.env ? { env: input.env } : {}),
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
    ...("latestVersion" in input ? { latestVersion: input.latestVersion } : {}),
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  });
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/");
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

/**
 * The npm global prefix that owns a package, derived from the real path of
 * its entry point: `<prefix>/lib/node_modules/<pkg>/…`. Windows global
 * installs have no `lib` segment and are proven by the shim instead (see
 * `resolveNpmGlobalPrefix`). A project-local `node_modules` is not a global
 * install and yields null.
 */
export function npmGlobalPrefixFromCommandPath(
  realCommandPath: string,
  packageName: string,
): string | null {
  const slashPath = realCommandPath.replaceAll("\\", "/");
  const normalized = slashPath.toLowerCase();
  const packageSegment = `/lib/node_modules/${packageName.toLowerCase()}/`;
  const packageIndex = normalized.lastIndexOf(packageSegment);
  if (packageIndex < 0 || normalized.slice(0, packageIndex).includes("/node_modules/")) {
    return null;
  }
  return packageIndex === 0 ? "/" : slashPath.slice(0, packageIndex);
}

// `<prefix>/Cellar/<name>/<version>/…` or `<prefix>/Caskroom/<name>/<version>/…`.
// Homebrew always nests a version directory under the keg.
const HOMEBREW_KEG_PATTERN = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i;

export interface HomebrewOwnership {
  readonly kind: "formula" | "cask";
  readonly name: string;
  /** The Homebrew prefix the keg sits under; must match `brew --prefix`. */
  readonly prefix: string;
}

/**
 * Homebrew looks like the owner when the real path runs through a versioned
 * keg or cask. It is only proven once the prefix matches the `brew` that will
 * run the upgrade (see `resolvePackageManagedProviderMaintenance`).
 */
export function homebrewOwnershipFromCommandPath(
  realCommandPath: string,
): HomebrewOwnership | null {
  const match = HOMEBREW_KEG_PATTERN.exec(realCommandPath.replaceAll("\\", "/"));
  if (!match) {
    return null;
  }
  return {
    kind: match[2]!.toLowerCase() === "cellar" ? "formula" : "cask",
    name: match[3]!,
    prefix: match[1]!,
  };
}

const HomebrewInfoResponse = Schema.Struct({
  formulae: Schema.optional(
    Schema.Array(
      Schema.Struct({
        versions: Schema.optional(Schema.Struct({ stable: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  casks: Schema.optional(Schema.Array(Schema.Struct({ version: Schema.optional(Schema.String) }))),
});

const decodeHomebrewInfo = Schema.decodeUnknownOption(Schema.fromJsonString(HomebrewInfoResponse));

/** Cask versions may carry a build suffix after a comma (`1.2.3,456`). */
export function parseHomebrewLatestVersion(
  infoJson: string,
  ownership: HomebrewOwnership,
): string | null {
  const decoded = decodeHomebrewInfo(infoJson);
  if (Option.isNone(decoded)) {
    return null;
  }
  const raw =
    ownership.kind === "formula"
      ? decoded.value.formulae?.[0]?.versions?.stable
      : decoded.value.casks?.[0]?.version?.split(",", 1)[0];
  return nonEmptyString(raw);
}

/** Run `brew <args>` and return stdout, or null on failure, timeout, or oversized output. */
const runHomebrew = Effect.fn("runHomebrew")(function* (
  brewPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const collect = Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make(brewPath, args, { env, extendEnv: true }));
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    // stderr is drained so a chatty brew cannot block on a full pipe.
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: HOMEBREW_INFO_MAX_BYTES }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return Number(exitCode) !== 0 || stdout.truncated ? null : stdout.text;
  });
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(HOMEBREW_INFO_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
    Effect.catchCause((cause) =>
      Effect.logWarning("Homebrew probe failed", {
        subcommand: args[0],
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

/**
 * Derive update capabilities from where the executable actually lives. Every
 * branch that yields a one-click command has evidence that the named tool
 * owns that path; anything unproven stays manual-only so T3 Code never runs
 * a package manager against an install it did not create.
 */
export const resolvePackageManagedProviderMaintenance = Effect.fn(
  "resolvePackageManagedProviderMaintenance",
)(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  context: ProviderMaintenanceResolutionContext | null,
) {
  const manual = makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  });
  if (!context) {
    return manual;
  }
  const commandPaths = [context.resolvedCommandPath, context.realCommandPath];
  const packageName = definition.npmPackageName;

  const nativeUpdate = definition.nativeUpdate;
  if (nativeUpdate && commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath))) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: nativeUpdate.args,
      updateLockKey: `${definition.provider}-native`,
      platform: context.platform,
      ...(nativeUpdate.env ? { env: nativeUpdate.env } : {}),
    });
  }
  if (commandPaths.some(isVitePlusGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "vp",
      updateArgs: ["i", "-g", packageName],
      updateLockKey: "vite-plus-global",
    });
  }
  if (commandPaths.some(isBunGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "bun",
      updateArgs: ["i", "-g", `${packageName}@latest`],
      updateLockKey: "bun-global",
    });
  }
  if (commandPaths.some(isPnpmGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "pnpm",
      updateArgs: ["add", "-g", `${packageName}@latest`],
      updateLockKey: "pnpm-global",
    });
  }

  // npm proof names the package, so it outranks a keg the path merely passes
  // through: a Homebrew-installed Node keeps its globals under
  // `Cellar/node/<ver>/lib/node_modules/`, and that is npm's install, not brew's.
  const npmPrefix = yield* resolveNpmGlobalPrefix(context, packageName);
  if (npmPrefix) {
    // npm 12 blocks install scripts by default (empty allow-scripts allowlist)
    // and still exits 0, so a package whose postinstall finishes the install
    // (claude copies its native binary over a placeholder stub) is left broken
    // while the update reports success. Allow this one package's scripts.
    // Older npm warns about the unknown config and continues.
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "npm",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        npmPrefix,
        `--allow-scripts=${packageName}`,
        `${packageName}@latest`,
      ],
      updateLockKey: `npm-global:${normalizeCommandPath(npmPrefix)}`,
    });
  }

  const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
  if (homebrew) {
    const brewPath = yield* resolveCommandPath("brew", { env: context.env }).pipe(
      Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
    );
    if (!brewPath) {
      return manual;
    }
    // A keg-shaped path is only Homebrew's if it sits under the prefix of the
    // `brew` that would upgrade it; `brew --prefix` is a cheap shell script.
    const fileSystem = yield* FileSystem.FileSystem;
    const brewPrefix = nonEmptyString(yield* runHomebrew(brewPath, ["--prefix"], context.env));
    const realBrewPrefix = brewPrefix
      ? yield* fileSystem.realPath(brewPrefix).pipe(Effect.orElseSucceed(() => brewPrefix))
      : null;
    if (
      !realBrewPrefix ||
      normalizeCommandPath(realBrewPrefix) !== normalizeCommandPath(homebrew.prefix)
    ) {
      return manual;
    }
    const args =
      homebrew.kind === "cask" ? ["upgrade", "--cask", homebrew.name] : ["upgrade", homebrew.name];
    // Homebrew lags npm by hours on every release, so compare against what
    // `brew upgrade` can actually deliver.
    const info = yield* runHomebrew(brewPath, ["info", "--json=v2", homebrew.name], context.env);
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: brewPath,
      updateArgs: args,
      updateLockKey: "homebrew",
      updateCommand: ["brew", ...args].join(" "),
      latestVersion: info ? parseHomebrewLatestVersion(info, homebrew) : null,
    });
  }

  return manual;
});

/**
 * POSIX npm links `<prefix>/bin/<cmd>` into the package, so the real path is
 * proof. Windows npm writes `.cmd` shims beside `node_modules`, so the proof
 * is the package manifest next to the shim.
 */
const resolveNpmGlobalPrefix = Effect.fn("resolveNpmGlobalPrefix")(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
) {
  const fromRealPath = npmGlobalPrefixFromCommandPath(context.realCommandPath, packageName);
  if (fromRealPath) {
    return fromRealPath;
  }
  if ((yield* HostProcessPlatform) !== "win32") {
    return null;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shimDir = path.dirname(context.resolvedCommandPath);
  const manifestPath = path.join(
    shimDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  // npm writes both `<cmd>.cmd` and an extensionless sh script into the
  // Windows prefix; either one sits directly beside `node_modules`. A POSIX
  // project checkout has the same shape, which is why this is Windows-only.
  const hasManifest = yield* fileSystem
    .exists(manifestPath)
    .pipe(Effect.orElseSucceed(() => false));
  return hasManifest ? shimDir : null;
});

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (context) => resolvePackageManagedProviderMaintenance(definition, context),
  };
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

/**
 * Locate the configured provider executable, follow symlinks, and hand the
 * result to the resolver. A binary that cannot be found yields the resolver's
 * no-context answer.
 */
export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: {
    readonly binaryPath?: string | null;
    readonly env?: NodeJS.ProcessEnv;
  },
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return yield* resolver.resolve(null);
  }

  const env = options?.env ?? (yield* readCommandLookupEnv);
  // resolveCommandPath checks explicit paths for existence too, so a missing
  // binary always lands in the no-context branch and never gets an update
  // command it cannot run.
  const resolvedCommandPath = yield* resolveCommandPath(binaryPath, { env }).pipe(
    Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
  );
  if (!resolvedCommandPath) {
    return yield* resolver.resolve(null);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (!realCommandPath) {
    return yield* resolver.resolve(null);
  }
  return yield* resolver.resolve({
    binaryPath,
    resolvedCommandPath,
    realCommandPath,
    env,
    platform: yield* HostProcessPlatform,
  });
});

/**
 * Turn a one-shot resolution into the shape drivers expose: a cached read for
 * advisories and a `fresh` read that update execution uses so it never trusts
 * ownership derived before the user clicked.
 */
export const makeCachedProviderMaintenanceResolution = Effect.fn(
  "makeCachedProviderMaintenanceResolution",
)(function* (resolve: Effect.Effect<ProviderMaintenanceCapabilities>) {
  const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    resolve,
    MAINTENANCE_CAPABILITIES_CACHE_TTL,
  );
  return (options?: { readonly fresh?: boolean }) =>
    options?.fresh ? invalidate.pipe(Effect.andThen(cached)) : cached;
});

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),
    Effect.orElseSucceed(() => null),
  );
  return payload ? nonEmptyString(payload.version) : null;
});

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  if (maintenanceCapabilities.latestVersion !== undefined) {
    return maintenanceCapabilities.latestVersion;
  }
  const packageName = maintenanceCapabilities.packageName;
  if (!packageName) {
    return null;
  }

  const latestVersionCache = yield* ProviderVersionCache;
  const cached = latestVersionCache.get(packageName);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = yield* fetchNpmLatestVersion(packageName);
  latestVersionCache.set(packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  return version;
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (
  snapshot: ServerProvider,
  maintenanceCapabilities?: ProviderMaintenanceCapabilities,
  options?: {
    readonly enableProviderUpdateChecks: boolean | undefined;
  },
) {
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver);
  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(snapshot.version);
  if (!shouldResolveLatestVersion) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  const latestVersion = yield* resolveLatestProviderVersion(capabilities);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});

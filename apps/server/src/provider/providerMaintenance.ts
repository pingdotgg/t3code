import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { makeProviderInstallationCatalog } from "./maintenance/catalogs.ts";
import type { InstallationContext, ResolvedInstallation } from "./maintenance/definition.ts";
import { resolveInstallation } from "./maintenance/resolver.ts";
import { compareMaintenanceVersions } from "./maintenance/version.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const MAINTENANCE_PROBE_TIMEOUT_MS = 10_000;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

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
const MAINTENANCE_PROBE_MAX_BYTES = 64_000;

const runMaintenanceProbe = Effect.fn("runMaintenanceProbe")(function* (input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}) {
  yield* FileSystem.FileSystem;
  yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolved = yield* resolveSpawnCommand(input.executable, input.args, {
    env: input.environment,
    extendEnv: true,
  }).pipe(Effect.option);
  if (Option.isNone(resolved)) return null;
  const result = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.value.command, resolved.value.args, {
        env: input.environment,
        extendEnv: true,
        shell: resolved.value.shell,
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: MAINTENANCE_PROBE_MAX_BYTES }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: MAINTENANCE_PROBE_MAX_BYTES }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout: stdout.text, stderr: stderr.text, exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(MAINTENANCE_PROBE_TIMEOUT_MS)),
    Effect.catchCause(() => Effect.succeed(Option.none())),
  );
  return Option.getOrNull(result);
});

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  readonly identityKey?: string | null;
  readonly installationLabel?: string | null;
  readonly ownershipVerified?: boolean;
  readonly currentVersion?: string | null;
  readonly latestVersion?: string | null;
  readonly instructionsUrl?: string | null;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ProviderMaintenanceCapabilityResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly resolvedCommandPath?: string | null;
  readonly realCommandPath?: string | null;
}

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    options?: ProviderMaintenanceCapabilityResolutionOptions,
  ) => ProviderMaintenanceCapabilities;
  readonly resolveInstallation?: (
    context: InstallationContext,
  ) => Effect.Effect<ResolvedInstallation>;
}

export interface ProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly packageName: string;
  readonly homebrewFormula: string | null;
  readonly nativeUpdate: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly lockKey: string;
    readonly isCommandPath: (commandPath: string) => boolean;
    readonly environment?: (
      executable: string,
      environment: NodeJS.ProcessEnv,
    ) => NodeJS.ProcessEnv;
  } | null;
  readonly executableName?: string;
  readonly instructionsUrl?: string;
  readonly wingetPackageId?: string;
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

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  readonly updateCommand?: string;
  readonly updateEnvironment?: NodeJS.ProcessEnv;
  readonly identityKey?: string | null;
  readonly installationLabel?: string | null;
  readonly ownershipVerified?: boolean;
  readonly currentVersion?: string | null;
  readonly latestVersion?: string | null;
  readonly instructionsUrl?: string | null;
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command: input.updateCommand ?? [input.updateExecutable, ...input.updateArgs].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          ...(input.updateEnvironment ? { environment: input.updateEnvironment } : {}),
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
    ...("identityKey" in input ? { identityKey: input.identityKey ?? null } : {}),
    ...("installationLabel" in input ? { installationLabel: input.installationLabel ?? null } : {}),
    ...("ownershipVerified" in input
      ? { ownershipVerified: input.ownershipVerified ?? false }
      : {}),
    ...("currentVersion" in input ? { currentVersion: input.currentVersion ?? null } : {}),
    ...("latestVersion" in input ? { latestVersion: input.latestVersion ?? null } : {}),
    ...("instructionsUrl" in input ? { instructionsUrl: input.instructionsUrl ?? null } : {}),
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

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: ProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.packageName,
    updateExecutable: "npm",
    // npm 12 blocks install scripts by default (empty allow-scripts allowlist)
    // and still exits 0, so a package whose postinstall finishes the install
    // (claude copies its native binary over a placeholder stub) is left broken
    // while the update reports success. Allow this one package's scripts.
    // Older npm warns about the unknown config and continues.
    updateArgs: [
      "install",
      "-g",
      `--allow-scripts=${definition.packageName}`,
      `${definition.packageName}@latest`,
    ],
    updateLockKey: "npm-global",
  });
}

function makeBunGlobalProviderMaintenanceCapabilities(
  definition: ProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.packageName,
    updateExecutable: "bun",
    updateArgs: ["i", "-g", `${definition.packageName}@latest`],
    updateLockKey: "bun-global",
  });
}

function makePnpmGlobalProviderMaintenanceCapabilities(
  definition: ProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.packageName,
    updateExecutable: "pnpm",
    updateArgs: ["add", "-g", `${definition.packageName}@latest`],
    updateLockKey: "pnpm-global",
  });
}

function makeVitePlusGlobalProviderMaintenanceCapabilities(
  definition: ProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.packageName,
    updateExecutable: "vp",
    updateArgs: ["i", "-g", definition.packageName],
    updateLockKey: "vite-plus-global",
  });
}

function makeHomebrewProviderMaintenanceCapabilities(
  definition: ProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  if (!definition.homebrewFormula) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.packageName,
    });
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.packageName,
    updateExecutable: "brew",
    updateArgs: ["upgrade", definition.homebrewFormula],
    updateLockKey: "homebrew",
  });
}

function makeNativeProviderMaintenanceCapabilities(
  definition: ProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities | null {
  if (!definition.nativeUpdate) {
    return null;
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.packageName,
    updateExecutable: definition.nativeUpdate.executable,
    updateArgs: definition.nativeUpdate.args,
    updateLockKey: definition.nativeUpdate.lockKey,
  });
}

export function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/");
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

function isNpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/node_modules/.bin/") ||
    normalized.includes("/lib/node_modules/") ||
    normalized.includes("/npm/node_modules/")
  );
}

function isHomebrewCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/opt/homebrew/cellar/") ||
    normalized.includes("/usr/local/cellar/") ||
    normalized.includes("/homebrew/cellar/") ||
    normalized.includes("/opt/homebrew/caskroom/") ||
    normalized.includes("/usr/local/caskroom/") ||
    normalized.includes("/homebrew/caskroom/") ||
    normalized.startsWith("/opt/homebrew/bin/") ||
    normalized.startsWith("/usr/local/bin/")
  );
}

function resolveLegacyProviderMaintenance(
  definition: ProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition);
  }

  const resolvedCommandPath =
    options?.resolvedCommandPath ?? (hasPathSeparator(binaryPath) ? binaryPath : null);

  if (resolvedCommandPath) {
    const commandPaths = [
      resolvedCommandPath,
      ...(options?.realCommandPath ? [options.realCommandPath] : []),
    ];

    const nativeUpdate = definition.nativeUpdate;
    if (
      nativeUpdate &&
      commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath))
    ) {
      return (
        makeNativeProviderMaintenanceCapabilities(definition) ??
        makeNpmGlobalProviderMaintenanceCapabilities(definition)
      );
    }
    if (commandPaths.some(isVitePlusGlobalCommandPath)) {
      return makeVitePlusGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isBunGlobalCommandPath)) {
      return makeBunGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isPnpmGlobalCommandPath)) {
      return makePnpmGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isNpmGlobalCommandPath)) {
      return makeNpmGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isHomebrewCommandPath)) {
      return makeHomebrewProviderMaintenanceCapabilities(definition);
    }
  }

  if (!hasPathSeparator(binaryPath)) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition);
  }

  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.packageName,
  });
}

export function makeProviderMaintenanceResolver(
  definition: ProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  const executableName =
    definition.executableName ??
    (definition.provider === ProviderDriverKind.make("claudeAgent")
      ? "claude"
      : definition.provider === ProviderDriverKind.make("opencode")
        ? "opencode"
        : "codex");
  const catalog = makeProviderInstallationCatalog({
    provider: definition.provider,
    packageName: definition.packageName,
    executableName,
    homebrewFormula: definition.homebrewFormula,
    native: definition.nativeUpdate
      ? {
          label: "Managed by native installer",
          updateArgs: definition.nativeUpdate.args,
          ownsPath: definition.nativeUpdate.isCommandPath,
          ...(definition.nativeUpdate.environment
            ? { environment: definition.nativeUpdate.environment }
            : {}),
        }
      : definition.provider === ProviderDriverKind.make("codex")
        ? {
            label: "Managed by Codex standalone installer",
            updateArgs: ["update"],
            ownsPath: (path) => path.includes("/.codex/packages/standalone/releases/"),
          }
        : null,
    instructionsUrl: definition.instructionsUrl ?? "https://t3.codes/docs/providers",
    ...(definition.wingetPackageId ? { wingetPackageId: definition.wingetPackageId } : {}),
  });
  return {
    resolve: (options) => resolveLegacyProviderMaintenance(definition, options),
    resolveInstallation: (context) => resolveInstallation(context, catalog),
  };
}

export function makeStaticProviderMaintenanceResolver(
  capabilities: ProviderMaintenanceCapabilities,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: () => capabilities,
  };
}

function capabilitiesFromInstallation(
  provider: ProviderDriverKind,
  installation: ResolvedInstallation,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: installation.packageName,
    updateExecutable: installation.update?.executable ?? null,
    updateArgs: installation.update?.args ?? [],
    updateLockKey: installation.update ? installation.lockKey : null,
    ...(installation.update ? { updateCommand: installation.update.displayCommand } : {}),
    ...(installation.update?.environment
      ? { updateEnvironment: installation.update.environment }
      : {}),
    identityKey: installation.identityKey,
    installationLabel: installation.label,
    ownershipVerified: installation.ownershipVerified,
    currentVersion: installation.currentVersion,
    latestVersion: installation.latestVersion,
    instructionsUrl: installation.instructionsUrl,
  });
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: Omit<ProviderMaintenanceCapabilityResolutionOptions, "realCommandPath">,
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return resolver.resolve(options);
  }

  const env = options?.env ?? (yield* readCommandLookupEnv);
  const resolvedCommandPath =
    (yield* resolveCommandPath(binaryPath, { env }).pipe(
      Effect.catchTag("CommandResolutionError", () => Effect.succeed(null)),
    )) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);
  if (!resolvedCommandPath) {
    return resolver.resolve(options);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => resolvedCommandPath));
  const resolutionOptions = {
    ...options,
    env,
    resolvedCommandPath,
    realCommandPath,
  };
  if (!resolver.resolveInstallation) {
    return resolver.resolve(resolutionOptions);
  }
  const legacy = resolver.resolve(resolutionOptions);
  const context: InstallationContext = {
    provider: legacy.provider,
    packageName: legacy.packageName ?? "",
    binaryPath,
    isBareCommand: !hasPathSeparator(binaryPath),
    resolvedCommandPath,
    realCommandPath,
    environment: env,
    platform,
    readTextFile: (path) =>
      path
        ? fileSystem.readFileString(path).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none()),
            Effect.map(Option.getOrNull),
          )
        : Effect.succeed(null),
    realPath: (path) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path)),
    resolveCommand: (command) =>
      resolveCommandPath(command, { env }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.map(Option.some),
        Effect.catchTags({ CommandResolutionError: () => Effect.succeed(Option.none()) }),
        Effect.map(Option.getOrNull),
      ),
    run: (executable, args, environment = env) =>
      runMaintenanceProbe({
        executable,
        args,
        environment,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
  };
  return capabilitiesFromInstallation(
    legacy.provider,
    yield* resolver.resolveInstallation(context),
  );
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
  if (compareMaintenanceVersions(input.currentVersion, input.latestVersion) === -1) {
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
  const latestVersion =
    "latestVersion" in input ? (input.latestVersion ?? null) : (capabilities.latestVersion ?? null);
  const currentVersion = capabilities.currentVersion ?? input.currentVersion;
  const advisory = deriveVersionAdvisory({
    currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion,
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
        latestVersion: null,
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

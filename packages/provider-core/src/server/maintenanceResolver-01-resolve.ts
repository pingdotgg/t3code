import { CHOCOLATEY_CLAUDE_PACKAGE_ID, LATEST_VERSION_TIMEOUT_MS, MAINTENANCE_CAPABILITIES_CACHE_TTL, MISE_WRAPPER_MAX_BYTES, NpmLatestVersionResponse, PROVIDER_UPDATE_ACTION_TOAST_MESSAGE, decodePnpmList, decodePnpmOutdated, homebrewOwnershipFromCommandPath, isBunGlobalCommandPath, isChocolateyClaudeCommandPath, isMiseCommandPath, isPnpmGlobalCommandPath, isVitePlusGlobalCommandPath, isWinGetClaudeCommandPath, isYarnGlobalCommandPath, makeManualOnlyProviderMaintenanceCapabilities, makeProviderMaintenanceCapabilities, makeTargetedProviderUpdateAction, nonEmptyString, normalizeCommandPath, npmGlobalPrefixFromCommandPath, parseChocolateyLatestVersion, parseHomebrewLatestVersion, readCommandLookupEnv, resolveLatestProviderUpdateAction, runProbe } from "./maintenanceResolver-02-latest.ts";
import type { HomebrewOwnership, PackageManagedProviderMaintenanceDefinition, ProviderMaintenanceCapabilitiesResolver, ProviderMaintenanceResolutionContext, ProviderMaintenanceResolverServices } from "./maintenanceResolver-02-latest.ts";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenance";
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { compareSemverVersions, satisfiesSemverRange } from "@t3tools/shared/semver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
export type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenance";

export const resolvePnpmGlobalLatestVersion = Effect.fn("resolvePnpmGlobalLatestVersion")(function* (
  packageName: string,
  env: NodeJS.ProcessEnv,
) {
  // Match the updater's pnpm and environment.
  const pnpmPath = yield* resolveCommandPath("pnpm", {
    env: { ...(yield* HostProcess.Environment), ...env },
  });
  if (!pnpmPath) return null;
  // Silent reporting keeps project package-manager warnings out of the JSON.
  const outdated = yield* runProbe(
    pnpmPath,
    ["outdated", "-g", "--reporter=silent", "--format", "json", packageName],
    env,
    // pnpm outdated exits 1 when updates are available.
    [0, 1],
  );
  const outdatedEntries = outdated
    ? Option.getOrUndefined(decodePnpmOutdated(outdated))
    : undefined;
  if (!outdatedEntries) return null;
  const latest = nonEmptyString(outdatedEntries[packageName]?.latest);
  if (latest) return latest;
  // An empty result means the installed version is still the eligible release.
  const listed = yield* runProbe(
    pnpmPath,
    ["ls", "-g", "--reporter=silent", "--depth", "0", "--json", packageName],
    env,
  );
  const listedEntries = listed ? Option.getOrUndefined(decodePnpmList(listed)) : undefined;
  return nonEmptyString(listedEntries?.[0]?.dependencies?.[packageName]?.version);
});

export const resolvePackageManagedProviderMaintenance = Effect.fn(
  "resolvePackageManagedProviderMaintenance",
)(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  context: ProviderMaintenanceResolutionContext | null,
) {
  if (!context) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
    });
  }
  const manual = makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    installPath: context.realCommandPath,
  });
  const commandPaths = [context.resolvedCommandPath, context.realCommandPath];
  const packageName = definition.npmPackageName;
  // WinGet-managed claude update exits 0 without updating; T3 does not run winget upgrade.
  if (
    definition.provider === "claudeAgent" &&
    context.platform === "win32" &&
    commandPaths.some(isWinGetClaudeCommandPath)
  ) {
    return manual;
  }
  // Chocolatey's package directory is writable only by administrators, so an
  // unelevated server cannot run `choco upgrade`; `claude update` through the
  // shim installs a native copy elsewhere and leaves the shim's version alone.
  if (
    definition.provider === "claudeAgent" &&
    context.platform === "win32" &&
    commandPaths.some((commandPath) => isChocolateyClaudeCommandPath(commandPath, context.env))
  ) {
    const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      installPath: context.realCommandPath,
      manualCommand: "choco upgrade claude-code",
      lookupLatestVersion: runProbe(
        "choco",
        ["search", CHOCOLATEY_CLAUDE_PACKAGE_ID, "--exact", "--limit-output"],
        context.env,
      ).pipe(
        Effect.map((output) =>
          output ? parseChocolateyLatestVersion(output, CHOCOLATEY_CLAUDE_PACKAGE_ID) : null,
        ),
        Effect.provideContext(services),
      ),
    });
  }

  const nativeUpdate = definition.nativeUpdate;
  const nativeEnv = nativeUpdate?.env;
  const native = nativeUpdate
    ? makeProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName,
        updateExecutable: context.resolvedCommandPath,
        updateArgs: nativeUpdate.args,
        updateLockKey: `${definition.provider}-native`,
        platform: context.platform,
        ...(nativeEnv
          ? { env: typeof nativeEnv === "function" ? nativeEnv(context) : nativeEnv }
          : {}),
      })
    : manual;
  // A native-looking launcher can still delegate to an npm- or mise-owned install.
  if (
    nativeUpdate?.isCommandPath &&
    commandPaths.some(nativeUpdate.isCommandPath) &&
    !npmGlobalPrefixFromCommandPath(context.realCommandPath, packageName) &&
    !commandPaths.some(isMiseCommandPath) &&
    !(yield* isMiseWrapperScript(context))
  ) {
    return native;
  }
  // A `node_modules` path not proven below belongs to another package or a
  // project, so the provider's own updater could act on the wrong install.
  const fallback =
    nativeUpdate?.requiresCommandPath ||
    commandPaths.some((commandPath) => normalizeCommandPath(commandPath).includes("/node_modules/"))
      ? manual
      : native;
  if (commandPaths.some(isVitePlusGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "vp",
      updateArgs: ["i", "-g", packageName],
      updateLockKey: "vite-plus-global",
      env: context.env,
    });
  }
  if (commandPaths.some(isBunGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "bun",
      updateArgs: ["i", "-g", `${packageName}@latest`],
      updateLockKey: "bun-global",
      env: context.env,
    });
  }
  if (commandPaths.some(isPnpmGlobalCommandPath)) {
    // pnpm 10 skips unapproved scripts; the approval flag requires 10.4+.
    const pnpmVersion = yield* runProbe("pnpm", ["--version"], context.env);
    const allowBuild =
      pnpmVersion !== null && satisfiesSemverRange(pnpmVersion, ">=10.4.0")
        ? [`--allow-build=${packageName}`]
        : [];
    const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "pnpm",
      updateArgs: ["add", "-g", ...allowBuild, `${packageName}@latest`],
      updateLockKey: "pnpm-global",
      env: context.env,
      lookupLatestVersion: resolvePnpmGlobalLatestVersion(packageName, context.env).pipe(
        Effect.provideContext(services),
      ),
    });
  }

  if (commandPaths.some(isYarnGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "yarn",
      updateArgs: ["global", "add", `${packageName}@latest`],
      updateLockKey: "yarn-global",
      env: context.env,
    });
  }
  if (yield* isVoltaPackageInstall(context, packageName)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "volta",
      updateArgs: ["install", `${packageName}@latest`],
      updateLockKey: "volta",
      env: context.env,
    });
  }

  // npm proof outranks a containing Homebrew keg; Homebrew Node globals still belong to npm.
  const npmPrefix = yield* resolveNpmGlobalPrefix(context, packageName);
  if (npmPrefix) {
    // npm 12 requires script approval to install native binaries; older npm only warns about the flag.
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
      env: context.env,
    });
  }

  const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
  if (
    commandPaths.some(isMiseCommandPath) ||
    // Mise shims resolve to the version manager's keg, not the provider's.
    (homebrew?.kind === "formula" && homebrew.name.toLowerCase() === "mise") ||
    (yield* isMiseWrapperScript(context))
  ) {
    return manual;
  }
  if (homebrew) {
    return (
      (yield* resolveHomebrewProviderMaintenance(
        { provider: definition.provider, packageName },
        homebrew,
        context,
      )) ?? fallback
    );
  }

  return fallback;
});

/**
 * `brew upgrade` capabilities once the keg's prefix is confirmed by a `brew`
 * that reports it as its own. Version checks defer `brew info` until needed.
 * Null when no `brew` is found or it owns another prefix.
 */
export const resolveHomebrewProviderMaintenance = Effect.fn("resolveHomebrewProviderMaintenance")(
  function* (
    input: { readonly provider: ProviderDriverKind; readonly packageName: string | null },
    homebrew: HomebrewOwnership,
    context: ProviderMaintenanceResolutionContext,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // GUI servers may lack Homebrew on PATH; use the keg brew with the same prefix check.
    const kegBrewPath = path.join(homebrew.prefix, "bin", "brew");
    const brewPath = (yield* fileSystem.exists(kegBrewPath).pipe(Effect.orElseSucceed(() => false)))
      ? kegBrewPath
      : yield* resolveCommandPath("brew", { env: context.env });
    if (!brewPath) {
      return null;
    }
    const brewPrefix = nonEmptyString(yield* runProbe(brewPath, ["--prefix"], context.env));
    const realBrewPrefix = brewPrefix
      ? yield* fileSystem.realPath(brewPrefix).pipe(Effect.orElseSucceed(() => brewPrefix))
      : null;
    if (
      !realBrewPrefix ||
      normalizeCommandPath(realBrewPrefix) !== normalizeCommandPath(homebrew.prefix)
    ) {
      return null;
    }
    const args =
      homebrew.kind === "cask" ? ["upgrade", "--cask", homebrew.name] : ["upgrade", homebrew.name];
    const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
    return makeProviderMaintenanceCapabilities({
      provider: input.provider,
      packageName: input.packageName,
      updateExecutable: brewPath,
      updateArgs: args,
      updateLockKey: "homebrew",
      updateCommand: ["brew", ...args].join(" "),
      // Brew's release can lag npm; only its own channel can say what upgrade installs.
      latestVersion: null,
      lookupLatestVersion: runProbe(
        brewPath,
        ["info", "--json=v2", homebrew.name],
        context.env,
      ).pipe(
        Effect.map((info) => (info ? parseHomebrewLatestVersion(info, homebrew) : null)),
        Effect.provideContext(services),
      ),
    });
  },
);

export const isMiseWrapperScript = Effect.fn("isMiseWrapperScript")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const size = yield* fileSystem.stat(context.realCommandPath).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => Infinity),
  );
  if (size > MISE_WRAPPER_MAX_BYTES) {
    return false;
  }
  const script = yield* fileSystem
    .readFileString(context.realCommandPath)
    .pipe(Effect.orElseSucceed(() => ""));
  return script.startsWith("#!") && /\bmise\s+(?:x|exec)\b/.test(script);
});

// Volta bin links only identify its shim; the package image proves ownership.
export const isVoltaPackageInstall = Effect.fn("isVoltaPackageInstall")(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
) {
  const path = yield* Path.Path;
  if (
    path.basename(normalizeCommandPath(context.realCommandPath)).replace(/\.exe$/, "") !==
    "volta-shim"
  ) {
    return false;
  }
  const voltaHome = path.dirname(path.dirname(context.resolvedCommandPath));
  const packageDir = path.join(voltaHome, "tools", "image", "packages", ...packageName.split("/"));
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.exists(packageDir).pipe(Effect.orElseSucceed(() => false));
});

export const resolveNpmGlobalPrefix = Effect.fn("resolveNpmGlobalPrefix")(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
) {
  const fromRealPath = npmGlobalPrefixFromCommandPath(context.realCommandPath, packageName);
  if (fromRealPath) {
    return fromRealPath;
  }
  if ((yield* HostProcess.Platform) !== "win32") {
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
  // Windows npm shims sit beside node_modules; POSIX project checkouts can mimic this layout.
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

export function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

export const decodeNpmViewVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Schema.String, Schema.Tuple([Schema.String])])),
);

export const withConfiguredNpmVersionLookup = Effect.fn("withConfiguredNpmVersionLookup")(function* (
  capabilities: ProviderMaintenanceCapabilities,
) {
  const packageName = capabilities.packageName;
  if (!packageName || capabilities.latestVersion !== undefined) {
    return capabilities;
  }
  const env = { ...(yield* HostProcess.Environment), ...capabilities.update?.env };
  const npmPath = yield* resolveCommandPath("npm", { env });
  if (!npmPath) return capabilities;
  const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
  const update = capabilities.update;
  const prefixIndex = update?.lockKey.startsWith("npm-global:")
    ? update.args.indexOf("--prefix")
    : -1;
  const prefix = prefixIndex >= 0 ? update?.args[prefixIndex + 1] : undefined;
  const lookup = runProbe(
    npmPath,
    [
      "view",
      "--global",
      ...(prefix ? ["--prefix", prefix] : []),
      "--json",
      `${packageName}@latest`,
      "version",
    ],
    env,
  ).pipe(
    Effect.map((stdout) => {
      const value = stdout ? Option.getOrNull(decodeNpmViewVersion(stdout.trim())) : null;
      return nonEmptyString(typeof value === "string" ? value : value?.[0]);
    }),
    Effect.tap((version) =>
      version === null
        ? Effect.logWarning("Configured npm version lookup failed", { packageName })
        : Effect.void,
    ),
    Effect.provideContext(services),
  );
  return {
    ...capabilities,
    // npm owns registry, scoped auth and proxy configuration; failure must not retry public npm.
    latestVersion: null,
    lookupLatestVersion: capabilities.lookupLatestVersion
      ? capabilities.lookupLatestVersion.pipe(
          Effect.filterOrElse(
            (version) => version !== null,
            () => lookup,
          ),
        )
      : lookup,
  };
});

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
  const resolvedCommandPath = yield* resolveCommandPath(binaryPath, { env });
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
    platform: yield* HostProcess.Platform,
  });
}, Effect.flatMap(withConfiguredNpmVersionLookup));

export const makeCachedProviderMaintenanceResolution = Effect.fn(
  "makeCachedProviderMaintenanceResolution",
)(function* (resolve: Effect.Effect<ProviderMaintenanceCapabilities>) {
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: MAINTENANCE_CAPABILITIES_CACHE_TTL,
    lookup: () => resolve,
  });
  const cached = Cache.get(cache, undefined);
  return (options?: { readonly fresh?: boolean }) =>
    options?.fresh ? Cache.invalidate(cache, undefined).pipe(Effect.andThen(cached)) : cached;
});

export function manualUpdateMessage(latestVersion: string, installPath: string | undefined): string {
  return installPath
    ? `Version ${latestVersion} is out. T3 Code runs ${installPath}; update it with the app or tool that installed it.`
    : `Version ${latestVersion} is out. Update it with the app or tool that installed it.`;
}

export function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly capabilities: ProviderMaintenanceCapabilities;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (
    (input.capabilities.compareVersions ?? compareSemverVersions)(
      input.currentVersion,
      input.latestVersion,
    ) < 0
  ) {
    return {
      status: "behind_latest",
      message:
        input.capabilities.update === null
          ? manualUpdateMessage(input.latestVersion, input.capabilities.installPath)
          : PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
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
    capabilities,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand:
      resolveLatestProviderUpdateAction(capabilities, latestVersion)?.command ??
      capabilities.manualCommand ??
      null,
    canUpdate: capabilities.update !== null,
    canInstallVersion: makeTargetedProviderUpdateAction(capabilities, "0.0.0") !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

export const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
  // The deadline covers the body too: headers can arrive before the JSON stalls.
  const payload = yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(NpmLatestVersionResponse)),
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  return Option.isSome(payload) ? nonEmptyString(payload.value.version) : null;
});

/**
 * The installer's own answer is cached apart from the npm registry entry. A
 * manual-only install has no command to key on, so its executable stands in.
 */
export function installerLatestVersionKey(capabilities: ProviderMaintenanceCapabilities) {
  if (!capabilities.lookupLatestVersion) return null;
  if (capabilities.latestVersionCacheKey) return capabilities.latestVersionCacheKey;
  const update = capabilities.update;
  if (update) return [update.lockKey, update.executable, ...update.args].join("\0");
  return capabilities.installPath
    ? ["manual", capabilities.installPath].join("\0")
    : capabilities.packageName && `npm-registry\0${capabilities.packageName}`;
}

export function latestProviderVersionCacheKeys(
  capabilities: ProviderMaintenanceCapabilities,
): ReadonlyArray<string> {
  return [capabilities.packageName, installerLatestVersionKey(capabilities)].filter(
    (key) => key !== null,
  );
}

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  const installerKey = installerLatestVersionKey(maintenanceCapabilities);
  if (installerKey && maintenanceCapabilities.lookupLatestVersion) {
    const installable = yield* latestVersions.cached(
      installerKey,
      maintenanceCapabilities.lookupLatestVersion,
    );
    if (installable !== null) return installable;
  }
  if (maintenanceCapabilities.latestVersion !== undefined) {
    return maintenanceCapabilities.latestVersion;
  }
  const packageName = maintenanceCapabilities.packageName;
  if (!packageName) {
    return null;
  }

  return yield* latestVersions.cached(packageName, fetchNpmLatestVersion(packageName));
});

export const invalidateLatestProviderVersion = Effect.fn("invalidateLatestProviderVersion")(
  function* (maintenanceCapabilities: ProviderMaintenanceCapabilities) {
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    yield* Effect.forEach(
      latestProviderVersionCacheKeys(maintenanceCapabilities),
      latestVersions.invalidate,
      { discard: true },
    );
  },
);

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
  const currentVersion =
    snapshot.installedVersion !== undefined ? snapshot.installedVersion : snapshot.version;
  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(currentVersion);
  if (!shouldResolveLatestVersion) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion,
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
      currentVersion,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});


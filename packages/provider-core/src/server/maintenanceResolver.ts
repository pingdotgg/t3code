export type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenance";
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
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "./collectStreamText.ts";
import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 256 * 1_024;
const MISE_WRAPPER_MAX_BYTES = 16 * 1_024;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

const MAINTENANCE_CAPABILITIES_CACHE_TTL = Duration.hours(1);

export interface ProviderMaintenanceResolutionContext {
  readonly binaryPath: string;
  readonly resolvedCommandPath: string;
  readonly realCommandPath: string;
  readonly env: NodeJS.ProcessEnv;
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
    readonly isCommandPath?: (commandPath: string) => boolean;
    readonly env?: NodeJS.ProcessEnv;
  } | null;
}

const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

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
  readonly updateCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly latestVersion?: string | null;
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
}): ProviderMaintenanceCapabilities {
  const platform = input.platform ?? HostProcess.Platform.defaultValue();
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
    ...(input.lookupLatestVersion ? { lookupLatestVersion: input.lookupLatestVersion } : {}),
  };
}

export function makeTargetedProviderUpdateAction(
  capabilities: ProviderMaintenanceCapabilities,
  version: string,
): ProviderMaintenanceCommandAction | null {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const update = capabilities.update;
  const packageName = capabilities.packageName;
  if (!update || !packageName) return null;
  if (
    !/^(?:npm-global:|bun-global$|pnpm-global$|vite-plus-global$|yarn-global$|volta$)/.test(
      update.lockKey,
    )
  )
    return null;
  const packageIndex = update.args.findIndex(
    (arg) => arg === `${packageName}@latest` || arg === packageName,
  );
  if (packageIndex < 0) return null;
  const args = update.args.map((arg, index) =>
    index === packageIndex ? `${packageName}@${version}` : arg,
  );
  const previous = update.args[packageIndex]!;
  const commandIndex = update.command.lastIndexOf(previous);
  const command =
    commandIndex < 0
      ? update.command
      : `${update.command.slice(0, commandIndex)}${packageName}@${version}${update.command.slice(commandIndex + previous.length)}`;
  return { ...update, args, command };
}

// pnpm 11 resolves `@latest` to the newest release older than `minimumReleaseAge`
// and exits 0, so a release advertised from the npm dist-tag would never install.
// An exact spec installs it and pnpm records it in `minimumReleaseAgeExclude`.
export function resolveLatestProviderUpdateAction(
  capabilities: ProviderMaintenanceCapabilities,
  latestVersion: string | null,
): ProviderMaintenanceCommandAction | null {
  const update = capabilities.update;
  if (update?.lockKey !== "pnpm-global" || latestVersion === null) return update;
  return makeTargetedProviderUpdateAction(capabilities, latestVersion) ?? update;
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly installPath?: string;
}): ProviderMaintenanceCapabilities {
  return {
    ...makeProviderMaintenanceCapabilities({
      provider: input.provider,
      packageName: input.packageName,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: null,
    }),
    ...(input.installPath ? { installPath: input.installPath } : {}),
  };
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

/**
 * Vite+ shims live in `<VP_HOME>/bin`: `~/.vite-plus` by default,
 * `~/.local/share/vite-plus` with the XDG layout, and `%LOCALAPPDATA%\vite-plus`
 * on Windows.
 */
function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return /\/(?:\.vite-plus|\.local\/share\/vite-plus|appdata\/local\/vite-plus)\/bin\//.test(
    normalizeCommandPath(commandPath),
  );
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isYarnGlobalCommandPath(commandPath: string): boolean {
  return /\/yarn\/(?:data\/)?global\/node_modules\//.test(normalizeCommandPath(commandPath));
}

/** Version-manager installs are pinned in its config, so updating them means editing that. */
function isMiseCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return normalized.includes("/mise/installs/") || normalized.includes("/mise/shims/");
}

/**
 * WinGet's Claude Code install under its user root (`<drive>:\Users\<name>\AppData\Local\Microsoft\WinGet`)
 * or machine root (`<drive>:\Program Files\WinGet`): the `Links\claude.exe` link or the binary in the
 * `Packages\Anthropic.ClaudeCode_…` directory.
 */
const winGetClaudeCommandPath =
  /^[a-z]:\/(?:users\/[^/]+\/appdata\/local\/microsoft|program files(?: \(x86\))?)\/winget\/(?:links|packages\/anthropic\.claudecode_[^/]+)\/claude\.exe$/;

function isWinGetClaudeCommandPath(commandPath: string): boolean {
  return winGetClaudeCommandPath.test(normalizeCommandPath(commandPath));
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
  // Mise's npm backend uses a global-looking layout inside a tool version.
  // Globals under its Node installation still belong to npm.
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(normalized.slice(0, packageIndex))?.[1];
  if (miseTool && miseTool !== "node") {
    return null;
  }
  return packageIndex === 0 ? "/" : slashPath.slice(0, packageIndex);
}

const HOMEBREW_KEG_PATTERN = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i;

export interface HomebrewOwnership {
  readonly kind: "formula" | "cask";
  readonly name: string;
  readonly prefix: string;
}

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
  const version = nonEmptyString(raw);
  return version === "latest" ? null : version;
}

const runProbe = Effect.fn("runProbe")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  okExitCodes: ReadonlyArray<number> = [0],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const collect = Effect.gen(function* () {
    // Windows package managers are `.cmd` shims that need the shell.
    const resolved = yield* resolveSpawnCommand(command, args, { env });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env,
        shell: resolved.shell,
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    // stderr is drained so a chatty tool cannot block on a full pipe.
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: PROBE_MAX_BYTES }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return !okExitCodes.includes(Number(exitCode)) || stdout.truncated ? null : stdout.text;
  });
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(PROBE_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
    Effect.catchCause((cause) =>
      Effect.logWarning("Maintenance probe failed", {
        command,
        subcommand: args[0],
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

const decodePnpmOutdated = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ latest: Schema.optional(Schema.String) })),
  ),
);
const decodePnpmList = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        dependencies: Schema.optional(
          Schema.Record(Schema.String, Schema.Struct({ version: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
);

// Unlike npm's latest tag, pnpm outdated respects minimumReleaseAge and its excludes.
const resolvePnpmGlobalLatestVersion = Effect.fn("resolvePnpmGlobalLatestVersion")(function* (
  packageName: string,
) {
  // Match the updater's pnpm and server environment, rather than the instance's.
  const pnpmPath = yield* resolveCommandPath("pnpm");
  if (!pnpmPath) return null;
  // Silent reporting keeps project package-manager warnings out of the JSON.
  const outdated = yield* runProbe(
    pnpmPath,
    ["outdated", "-g", "--reporter=silent", "--format", "json", packageName],
    {},
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
    {},
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
  // WinGet owns these files: `claude update` only reports "managed by winget"
  // and exits 0, and T3 Code does not run `winget upgrade` itself.
  if (
    definition.provider === "claudeAgent" &&
    context.platform === "win32" &&
    commandPaths.some(isWinGetClaudeCommandPath)
  ) {
    return manual;
  }

  const nativeUpdate = definition.nativeUpdate;
  const native = nativeUpdate
    ? makeProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName,
        updateExecutable: context.resolvedCommandPath,
        updateArgs: nativeUpdate.args,
        updateLockKey: `${definition.provider}-native`,
        platform: context.platform,
        ...(nativeUpdate.env ? { env: nativeUpdate.env } : {}),
      })
    : manual;
  // A native-looking launcher can still delegate to a mise-owned install.
  if (
    nativeUpdate?.isCommandPath &&
    commandPaths.some(nativeUpdate.isCommandPath) &&
    !commandPaths.some(isMiseCommandPath) &&
    !(yield* isMiseWrapperScript(context))
  ) {
    return native;
  }
  // A `node_modules` path not proven below belongs to another package or a
  // project, so the provider's own updater could act on the wrong install.
  const fallback = commandPaths.some((commandPath) =>
    normalizeCommandPath(commandPath).includes("/node_modules/"),
  )
    ? manual
    : native;
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
    // pnpm 10 skips unapproved install scripts and still exits 0, leaving a
    // package whose postinstall finishes the install broken. Global installs
    // can only approve on the command line, and pnpm before 10.4 rejects the
    // flag as an unknown option.
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
      lookupLatestVersion: resolvePnpmGlobalLatestVersion(packageName).pipe(
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
    });
  }
  if (yield* isVoltaPackageInstall(context, packageName)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "volta",
      updateArgs: ["install", `${packageName}@latest`],
      updateLockKey: "volta",
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
    // while the update reports success. Older npm warns about the unknown
    // config and continues.
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
    // The keg's own brew works even when a GUI-launched server has no
    // Homebrew on PATH; the prefix check below still applies to it.
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

const isMiseWrapperScript = Effect.fn("isMiseWrapperScript")(function* (
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

/**
 * Volta's `bin/<cmd>` is a link to its `volta-shim`, which picks the package
 * at run time; the package's own image directory proves Volta installed it.
 */
const isVoltaPackageInstall = Effect.fn("isVoltaPackageInstall")(function* (
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

const resolveNpmGlobalPrefix = Effect.fn("resolveNpmGlobalPrefix")(function* (
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

  const env = options?.env ?? (yield* mergeProviderInstanceEnvironment(undefined));
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
});

/**
 * Turn a one-shot resolution into the shape drivers expose: a cached read for
 * advisories and a `fresh` read that update execution uses so it never trusts
 * ownership derived before the user clicked.
 */
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

/**
 * An install T3 Code cannot update gets no Update button or command, so its
 * message names the version and the executable instead.
 */
function manualUpdateMessage(latestVersion: string, installPath: string | undefined): string {
  return installPath
    ? `Version ${latestVersion} is out. T3 Code runs ${installPath}; update it with the app or tool that installed it.`
    : `Version ${latestVersion} is out. Update it with the app or tool that installed it.`;
}

function deriveVersionAdvisory(input: {
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
    updateCommand: resolveLatestProviderUpdateAction(capabilities, latestVersion)?.command ?? null,
    canUpdate: capabilities.update !== null,
    canInstallVersion: makeTargetedProviderUpdateAction(capabilities, "0.0.0") !== null,
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

/** The installer's own answer is cached apart from the npm registry entry. */
function installerLatestVersionKey(capabilities: ProviderMaintenanceCapabilities) {
  const update = capabilities.update;
  return capabilities.lookupLatestVersion && update
    ? [update.lockKey, update.executable, ...update.args].join("\0")
    : null;
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

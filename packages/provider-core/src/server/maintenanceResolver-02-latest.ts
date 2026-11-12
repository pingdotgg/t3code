import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenance";
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { collectUint8StreamText } from "./collectStreamText.ts";
export type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenance";

export const LATEST_VERSION_TIMEOUT_MS = 4_000;
export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_MAX_BYTES = 256 * 1_024;
export const MISE_WRAPPER_MAX_BYTES = 16 * 1_024;
export const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

export const MAINTENANCE_CAPABILITIES_CACHE_TTL = Duration.hours(1);

export const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

export const CommandLookupEnvConfig = Config.all({
  PATH: Config.String("PATH").pipe(Config.option),
  Path: Config.String("Path").pipe(Config.option),
  path: Config.String("path").pipe(Config.option),
  PATHEXT: Config.String("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

export const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

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
    /** The updater cannot detect installs outside `isCommandPath`, so leave those manual-only. */
    readonly requiresCommandPath?: boolean;
    readonly env?:
      | NodeJS.ProcessEnv
      | ((context: ProviderMaintenanceResolutionContext) => NodeJS.ProcessEnv);
  } | null;
}

export const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function quoteShellWord(word: string, platform: NodeJS.Platform): string {
  const safeWord = platform === "win32" ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/;
  if (safeWord.test(word)) return word;
  return platform === "win32"
    ? `'${word.replace(/['\u2018\u2019]/g, "$&$&")}'`
    : `'${word.replaceAll("'", "'\\''")}'`;
}

export function quoteUpdateExecutable(executable: string, platform: NodeJS.Platform): string {
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
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  readonly manualCommand?: string;
}): ProviderMaintenanceCapabilities {
  return {
    ...makeProviderMaintenanceCapabilities({
      provider: input.provider,
      packageName: input.packageName,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: null,
      ...(input.lookupLatestVersion
        ? { latestVersion: null, lookupLatestVersion: input.lookupLatestVersion }
        : {}),
    }),
    ...(input.installPath ? { installPath: input.installPath } : {}),
    ...(input.manualCommand ? { manualCommand: input.manualCommand } : {}),
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
export function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return /\/(?:\.vite-plus|\.local\/share\/vite-plus|appdata\/local\/vite-plus)\/bin\//.test(
    normalizeCommandPath(commandPath),
  );
}

export function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

export function isYarnGlobalCommandPath(commandPath: string): boolean {
  return /\/yarn\/(?:data\/)?global\/node_modules\//.test(normalizeCommandPath(commandPath));
}

/**
 * Version-manager installs are pinned in its config, so updating them means editing that.
 * A command wrapper is a symlink to the `mise` binary, which dispatches on argv[0].
 */
export function isMiseCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/mise/installs/") ||
    normalized.includes("/mise/shims/") ||
    normalized.includes("/mise/command-wrappers/") ||
    /\/mise(?:\.exe)?$/.test(normalized)
  );
}

export const winGetClaudeCommandPath =
  /^[a-z]:\/(?:users\/[^/]+\/appdata\/local\/microsoft|program files(?: \(x86\))?)\/winget\/(?:links|packages\/anthropic\.claudecode_[^/]+)\/claude\.exe$/;

export function isWinGetClaudeCommandPath(commandPath: string): boolean {
  return winGetClaudeCommandPath.test(normalizeCommandPath(commandPath));
}

export const CHOCOLATEY_CLAUDE_PACKAGE_ID = "claude-code";

// Chocolatey's executable shim is not a symlink, so realpath cannot prove its owner.
export const chocolateyClaudeCommandPath = /\/chocolatey\/(?:bin|lib\/claude-code\/tools)\/claude\.exe$/;

export function isChocolateyClaudeCommandPath(commandPath: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = normalizeCommandPath(commandPath);
  if (chocolateyClaudeCommandPath.test(normalized)) return true;
  const root = nonEmptyString(env.ChocolateyInstall);
  if (!root) return false;
  const prefix = normalizeCommandPath(root.replace(/[\\/]+$/, ""));
  return (
    normalized === `${prefix}/bin/claude.exe` ||
    normalized === `${prefix}/lib/claude-code/tools/claude.exe`
  );
}

/** `choco search --exact --limit-output` prints `<id>|<version>` for a match and nothing otherwise. */
export function parseChocolateyLatestVersion(output: string, packageId: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const [id, version] = line.trim().split("|", 2);
    if (id?.toLowerCase() === packageId.toLowerCase()) return nonEmptyString(version);
  }
  return null;
}

export function isPnpmGlobalCommandPath(commandPath: string): boolean {
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
  // Mise tool layouts resemble npm globals; only globals under its Node install belong to npm.
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(normalized.slice(0, packageIndex))?.[1];
  if (miseTool && miseTool !== "node") {
    return null;
  }
  return packageIndex === 0 ? "/" : slashPath.slice(0, packageIndex);
}

export const HOMEBREW_KEG_PATTERN = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i;

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

export const HomebrewInfoResponse = Schema.Struct({
  formulae: Schema.optional(
    Schema.Array(
      Schema.Struct({
        versions: Schema.optional(Schema.Struct({ stable: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  casks: Schema.optional(Schema.Array(Schema.Struct({ version: Schema.optional(Schema.String) }))),
});

export const decodeHomebrewInfo = Schema.decodeUnknownOption(Schema.fromJsonString(HomebrewInfoResponse));

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

export const runProbe = Effect.fn("runProbe")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  okExitCodes: ReadonlyArray<number> = [0],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const collect = Effect.gen(function* () {
    // Windows package managers are `.cmd` shims that need the shell.
    const resolved = yield* resolveSpawnCommand(command, args, { env, extendEnv: true });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env,
        extendEnv: true,
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

export const decodePnpmOutdated = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ latest: Schema.optional(Schema.String) })),
  ),
);
export const decodePnpmList = Schema.decodeUnknownOption(
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

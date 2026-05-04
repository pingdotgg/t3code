import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { Effect, FileSystem, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { compareCliVersions } from "./cliVersion.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

type VersionLifecycleProvider = "codex" | "claudeAgent" | "cursor" | "opencode";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

export interface ProviderVersionLifecycle {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateCommand: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
}

interface ProviderVersionLifecycleResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly realCommandPath?: string | null;
}

interface PackageManagedProviderVersionLifecycleDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly homebrewFormula: string | null;
  readonly nativeUpdate: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly lockKey: string;
    readonly isCommandPath: (commandPath: string) => boolean;
  } | null;
}

const PROVIDER_VERSION_LIFECYCLES = {
  codex: {
    provider: CODEX_DRIVER,
    npmPackageName: "@openai/codex",
    homebrewFormula: "codex",
    nativeUpdate: null,
  },
  claudeAgent: {
    provider: CLAUDE_AGENT_DRIVER,
    npmPackageName: "@anthropic-ai/claude-code",
    homebrewFormula: "claude-code",
    nativeUpdate: {
      executable: "claude",
      args: ["update"],
      lockKey: "claude-native",
      isCommandPath: isClaudeNativeCommandPath,
    },
  },
  cursor: {
    provider: CURSOR_DRIVER,
    packageName: null,
    updateCommand: "agent update",
    updateExecutable: "agent",
    updateArgs: ["update"],
    updateLockKey: "cursor-agent",
  },
  opencode: {
    provider: OPENCODE_DRIVER,
    npmPackageName: "opencode-ai",
    homebrewFormula: "anomalyco/tap/opencode",
    nativeUpdate: {
      executable: "opencode",
      args: ["upgrade"],
      lockKey: "opencode-native",
      isCommandPath: isOpenCodeNativeCommandPath,
    },
  },
} as const satisfies Record<
  Exclude<VersionLifecycleProvider, "cursor">,
  PackageManagedProviderVersionLifecycleDefinition
> & {
  readonly cursor: ProviderVersionLifecycle;
};

interface LatestVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

const latestVersionCache = new Map<string, LatestVersionCacheEntry>();
const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isVersionLifecycleProvider(provider: string): provider is VersionLifecycleProvider {
  return provider in PROVIDER_VERSION_LIFECYCLES;
}

function makeProviderVersionLifecycle(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
}): ProviderVersionLifecycle {
  return {
    provider: input.provider,
    packageName: input.packageName,
    updateCommand:
      input.updateExecutable === null
        ? null
        : [input.updateExecutable, ...input.updateArgs].join(" "),
    updateExecutable: input.updateExecutable,
    updateArgs: input.updateArgs,
    updateLockKey: input.updateLockKey,
  };
}

function makeManualOnlyProviderVersionLifecycle(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
}): ProviderVersionLifecycle {
  return makeProviderVersionLifecycle({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  });
}

function makeNpmGlobalProviderVersionLifecycle(
  definition: PackageManagedProviderVersionLifecycleDefinition,
): ProviderVersionLifecycle {
  return makeProviderVersionLifecycle({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "npm",
    updateArgs: ["install", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "npm-global",
  });
}

function makeBunGlobalProviderVersionLifecycle(
  definition: PackageManagedProviderVersionLifecycleDefinition,
): ProviderVersionLifecycle {
  return makeProviderVersionLifecycle({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "bun",
    updateArgs: ["i", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "bun-global",
  });
}

function makePnpmGlobalProviderVersionLifecycle(
  definition: PackageManagedProviderVersionLifecycleDefinition,
): ProviderVersionLifecycle {
  return makeProviderVersionLifecycle({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "pnpm",
    updateArgs: ["add", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "pnpm-global",
  });
}

function makeVitePlusGlobalProviderVersionLifecycle(
  definition: PackageManagedProviderVersionLifecycleDefinition,
): ProviderVersionLifecycle {
  return makeProviderVersionLifecycle({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "vp",
    updateArgs: ["i", "-g", definition.npmPackageName],
    updateLockKey: "vite-plus-global",
  });
}

function makeHomebrewProviderVersionLifecycle(
  definition: PackageManagedProviderVersionLifecycleDefinition,
): ProviderVersionLifecycle {
  if (!definition.homebrewFormula) {
    return makeManualOnlyProviderVersionLifecycle({
      provider: definition.provider,
      packageName: definition.npmPackageName,
    });
  }

  return makeProviderVersionLifecycle({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "brew",
    updateArgs: ["upgrade", definition.homebrewFormula],
    updateLockKey: "homebrew",
  });
}

function makeNativeProviderVersionLifecycle(
  definition: PackageManagedProviderVersionLifecycleDefinition,
): ProviderVersionLifecycle | null {
  if (!definition.nativeUpdate) {
    return null;
  }

  return makeProviderVersionLifecycle({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: definition.nativeUpdate.executable,
    updateArgs: definition.nativeUpdate.args,
    updateLockKey: definition.nativeUpdate.lockKey,
  });
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function normalizeCommandPath(commandPath: string): string {
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

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

function resolvePackageManagedProviderVersionLifecycle(
  definition: PackageManagedProviderVersionLifecycleDefinition,
  options?: ProviderVersionLifecycleResolutionOptions,
): ProviderVersionLifecycle {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return makeNpmGlobalProviderVersionLifecycle(definition);
  }

  const resolvedCommandPath =
    resolveCommandPath(binaryPath, {
      ...(options?.platform ? { platform: options.platform } : {}),
      ...(options?.env ? { env: options.env } : {}),
    }) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);

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
        makeNativeProviderVersionLifecycle(definition) ??
        makeNpmGlobalProviderVersionLifecycle(definition)
      );
    }
    if (commandPaths.some(isVitePlusGlobalCommandPath)) {
      return makeVitePlusGlobalProviderVersionLifecycle(definition);
    }
    if (commandPaths.some(isBunGlobalCommandPath)) {
      return makeBunGlobalProviderVersionLifecycle(definition);
    }
    if (commandPaths.some(isPnpmGlobalCommandPath)) {
      return makePnpmGlobalProviderVersionLifecycle(definition);
    }
    if (commandPaths.some(isNpmGlobalCommandPath)) {
      return makeNpmGlobalProviderVersionLifecycle(definition);
    }
    if (commandPaths.some(isHomebrewCommandPath)) {
      return makeHomebrewProviderVersionLifecycle(definition);
    }
  }

  if (!hasPathSeparator(binaryPath)) {
    return makeNpmGlobalProviderVersionLifecycle(definition);
  }

  return makeManualOnlyProviderVersionLifecycle({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  });
}

export function haveProviderVersionLifecyclesEqual(
  left: ProviderVersionLifecycle,
  right: ProviderVersionLifecycle,
): boolean {
  return (
    left.provider === right.provider &&
    left.packageName === right.packageName &&
    left.updateCommand === right.updateCommand &&
    left.updateExecutable === right.updateExecutable &&
    left.updateLockKey === right.updateLockKey &&
    left.updateArgs.length === right.updateArgs.length &&
    left.updateArgs.every((value, index) => value === right.updateArgs[index])
  );
}

export function disableProviderVersionLifecycleUpdates(
  lifecycle: ProviderVersionLifecycle,
): ProviderVersionLifecycle {
  return makeManualOnlyProviderVersionLifecycle({
    provider: lifecycle.provider,
    packageName: lifecycle.packageName,
  });
}

export function getProviderVersionLifecycle(
  provider: ProviderDriverKind,
  options?: ProviderVersionLifecycleResolutionOptions,
): ProviderVersionLifecycle {
  const providerKey = String(provider);
  if (isVersionLifecycleProvider(providerKey)) {
    if (providerKey === "cursor") {
      return PROVIDER_VERSION_LIFECYCLES.cursor;
    }
    return resolvePackageManagedProviderVersionLifecycle(
      PROVIDER_VERSION_LIFECYCLES[providerKey],
      options,
    );
  }
  return makeManualOnlyProviderVersionLifecycle({
    provider,
    packageName: null,
  });
}

export function getProviderVersionLifecycleEffect(
  provider: ProviderDriverKind,
  options?: Omit<ProviderVersionLifecycleResolutionOptions, "realCommandPath">,
): Effect.Effect<ProviderVersionLifecycle, never, FileSystem.FileSystem> {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return Effect.succeed(getProviderVersionLifecycle(provider, options));
  }

  const resolvedCommandPath =
    resolveCommandPath(binaryPath, {
      ...(options?.platform ? { platform: options.platform } : {}),
      ...(options?.env ? { env: options.env } : {}),
    }) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);
  if (!resolvedCommandPath) {
    return Effect.succeed(getProviderVersionLifecycle(provider, options));
  }

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const realCommandPath = yield* fileSystem
      .realPath(resolvedCommandPath)
      .pipe(Effect.catch(() => Effect.succeed(resolvedCommandPath)));
    return getProviderVersionLifecycle(provider, {
      ...options,
      realCommandPath,
    });
  });
}

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
  if (compareCliVersions(input.currentVersion, input.latestVersion) < 0) {
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
  readonly versionLifecycle?: ProviderVersionLifecycle;
}): ServerProviderVersionAdvisory {
  const lifecycle = input.versionLifecycle ?? getProviderVersionLifecycle(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: lifecycle.updateCommand,
    canUpdate: lifecycle.updateExecutable !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

function fetchNpmLatestVersion(packageName: string): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const clientOption = yield* Effect.serviceOption(HttpClient.HttpClient);
    if (Option.isNone(clientOption)) {
      return null;
    }
    const client = clientOption.value;
    const request = HttpClientRequest.get(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
    const response = yield* client.execute(request).pipe(
      Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
      Effect.catch(() => Effect.succeed(Option.none())),
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
      Effect.catch(() => Effect.succeed(null)),
    );
    return payload ? nonEmptyString(payload.version) : null;
  });
}

export function resolveLatestProviderVersion(
  provider: ProviderDriverKind,
): Effect.Effect<string | null> {
  const lifecycle = getProviderVersionLifecycle(provider);
  const packageName = lifecycle.packageName;
  if (!packageName) {
    return Effect.succeed(null);
  }

  const cached = latestVersionCache.get(packageName);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return Effect.succeed(cached.version);
  }

  return fetchNpmLatestVersion(packageName).pipe(
    Effect.tap((version) =>
      Effect.sync(() => {
        latestVersionCache.set(packageName, {
          expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
          version,
        });
      }),
    ),
  );
}

export function enrichProviderSnapshotWithVersionAdvisory(
  snapshot: ServerProvider,
  versionLifecycle?: ProviderVersionLifecycle,
): Effect.Effect<ServerProvider> {
  return Effect.gen(function* () {
    const lifecycle = versionLifecycle ?? getProviderVersionLifecycle(snapshot.driver);
    if (!snapshot.enabled || !snapshot.installed || !snapshot.version) {
      return {
        ...snapshot,
        versionAdvisory: createProviderVersionAdvisory({
          driver: snapshot.driver,
          currentVersion: snapshot.version,
          checkedAt: snapshot.checkedAt,
          versionLifecycle: lifecycle,
        }),
      };
    }

    const latestVersion = yield* resolveLatestProviderVersion(snapshot.driver);
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        latestVersion,
        checkedAt: new Date().toISOString(),
        versionLifecycle: lifecycle,
      }),
    };
  });
}

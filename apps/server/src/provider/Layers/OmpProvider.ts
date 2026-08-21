import {
  type ModelCapabilities,
  type OmpSettings,
  type ServerProviderModel,
  type ServerProvider,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "../providerMaintenance.ts";
import { ompProfileFromLaunchArgs } from "../acp/OmpAcpSupport.ts";

export const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  showInteractionModeToggle: false,
} as const;

export const OMP_MINIMUM_VERSION = "17.4.0";
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const OMP_PROVIDER_WORD_LABELS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  github: "GitHub",
  gitlab: "GitLab",
  lm: "LM",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  xai: "xAI",
  zai: "Z.AI",
};

function ompSubProviderLabel(provider: string): string | undefined {
  const normalized = provider.trim();
  if (!normalized) return undefined;
  return normalized
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map(
      (word) =>
        OMP_PROVIDER_WORD_LABELS[word.toLowerCase()] ??
        `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const normalized = trimmedString(entry);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function thinkingLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function ompModelCapabilities(
  thinking: ReadonlyArray<string>,
  defaultThinking: string | undefined,
): ModelCapabilities {
  if (thinking.length === 0) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "thinking",
        label: "Thinking",
        options: thinking.map((value) => ({
          value,
          label: thinkingLabel(value),
          ...(value === defaultThinking ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

export interface OmpModelCatalogDefaults {
  readonly defaultModelRole?: string | undefined;
  readonly defaultThinking?: string | undefined;
}

/** Parses the documented `omp models --json` catalog without trusting malformed entries. */
export function buildOmpModelsFromJson(
  value: unknown,
  defaults: OmpModelCatalogDefaults = {},
): ReadonlyArray<ServerProviderModel> {
  const catalog = asRecord(value);
  if (!catalog || !Array.isArray(catalog.models)) return [];

  const catalogSelectors = catalog.models.flatMap((entry) => {
    const selector = trimmedString(asRecord(entry)?.selector);
    return selector ? [selector] : [];
  });
  const defaultSelector = catalogSelectors
    .toSorted((left, right) => right.length - left.length)
    .find(
      (selector) =>
        defaults.defaultModelRole === selector ||
        defaults.defaultModelRole?.startsWith(`${selector}:`),
    );
  const roleThinking =
    defaultSelector && defaults.defaultModelRole?.startsWith(`${defaultSelector}:`)
      ? trimmedString(defaults.defaultModelRole.slice(defaultSelector.length + 1))
      : undefined;

  const seen = new Set<string>();
  return catalog.models.flatMap((entry) => {
    const model = asRecord(entry);
    const selector = trimmedString(model?.selector);
    const name = trimmedString(model?.name);
    const provider = trimmedString(model?.provider);
    if (!selector || !name || !provider || seen.has(selector)) return [];
    seen.add(selector);

    return [
      {
        slug: selector,
        name,
        subProvider: ompSubProviderLabel(provider),
        isCustom: false,
        ...(selector === defaultSelector ? { isDefault: true } : {}),
        capabilities: ompModelCapabilities(
          stringArray(model?.thinking),
          selector === defaultSelector
            ? (roleThinking ?? defaults.defaultThinking)
            : defaults.defaultThinking,
        ),
      } satisfies ServerProviderModel,
    ];
  });
}

export function parseOmpModelsJson(
  output: string,
  defaults?: OmpModelCatalogDefaults,
): ReadonlyArray<ServerProviderModel> | undefined {
  try {
    return buildOmpModelsFromJson(JSON.parse(output) as unknown, defaults);
  } catch {
    return undefined;
  }
}

function parseOmpConfigValue(output: string): unknown {
  try {
    return asRecord(JSON.parse(output) as unknown)?.value;
  } catch {
    return undefined;
  }
}

function ompConfigOverlayArgs(launchArgs: string | null | undefined): ReadonlyArray<string> {
  const configArgs: Array<string> = [];
  const args = tokenizeCliArgs(launchArgs ?? undefined);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--config") {
      const value = args[index + 1]?.trim();
      if (value) {
        configArgs.push("--config", value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length).trim();
      if (value) configArgs.push("--config", value);
    }
  }
  return configArgs;
}

export function ompModelsCommandArgs(launchArgs: string | null | undefined): ReadonlyArray<string> {
  const configArgs = ompConfigOverlayArgs(launchArgs);
  return ["models", "--json", "--no-extensions", ...configArgs];
}

export function buildInitialOmpProviderSnapshot(
  settings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Oh My Pi availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Oh My Pi is disabled in T3 Code settings.",
          },
    });
  });
}

function runOmpCommand(
  settings: Pick<OmpSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  return Effect.gen(function* () {
    const command = settings.binaryPath?.trim() || "omp";
    const resolved = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
      }),
    );
  });
}

function readOptionalOmpConfigValue(
  settings: Pick<OmpSettings, "binaryPath">,
  key: string,
  environment: NodeJS.ProcessEnv,
) {
  return runOmpCommand(settings, ["config", "get", key, "--json"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result) || Option.isNone(result.success)) return undefined;
      const commandResult = result.success.value;
      return commandResult.code === 0 ? parseOmpConfigValue(commandResult.stdout) : undefined;
    }),
  );
}

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallback: ReadonlyArray<ServerProviderModel> = [];
  if (!settings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallback,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Oh My Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionExit = yield* runOmpCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionExit)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: !isCommandMissingCause(versionExit.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(versionExit.failure)
          ? "Oh My Pi (`omp`) is not installed or not on PATH."
          : "Failed to execute the Oh My Pi version check.",
      },
    });
  }
  if (Option.isNone(versionExit.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionResult = versionExit.success.value;
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0 || version === null) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi is installed but failed to report a valid version.",
      },
    });
  }
  if (compareSemverVersions(version, OMP_MINIMUM_VERSION) < 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Oh My Pi v${version} is too old. Upgrade to v${OMP_MINIMUM_VERSION} or newer.`,
      },
    });
  }

  const profile = ompProfileFromLaunchArgs(settings.launchArgs);
  const modelsEnvironment = profile ? { ...environment, OMP_PROFILE: profile } : environment;
  const modelsCommandArgs = ompModelsCommandArgs(settings.launchArgs);
  const hasConfigOverlays = modelsCommandArgs.length > 3;
  const modelsExit = yield* runOmpCommand(settings, modelsCommandArgs, modelsEnvironment).pipe(
    Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(modelsExit) || Option.isNone(modelsExit.success)) {
    const timedOut = Result.isSuccess(modelsExit) && Option.isNone(modelsExit.success);
    yield* Effect.logWarning("Oh My Pi model discovery failed", {
      errorTag: Result.isFailure(modelsExit) ? "process-error" : "timeout",
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: timedOut
          ? `Oh My Pi model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms.`
          : "Failed to list Oh My Pi models. Check server logs for details.",
      },
    });
  }

  const modelsResult = modelsExit.success.value;
  if (modelsResult.code !== 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Failed to list Oh My Pi models. Check server logs for details.",
      },
    });
  }

  const configDefaults = !hasConfigOverlays
    ? yield* Effect.all(
        {
          modelRoles: readOptionalOmpConfigValue(settings, "modelRoles", modelsEnvironment),
          defaultThinking: readOptionalOmpConfigValue(
            settings,
            "defaultThinkingLevel",
            modelsEnvironment,
          ),
        },
        { concurrency: "unbounded" },
      )
    : { modelRoles: undefined, defaultThinking: undefined };
  const discoveredModels = parseOmpModelsJson(modelsResult.stdout, {
    defaultModelRole: trimmedString(asRecord(configDefaults.modelRoles)?.default),
    defaultThinking: trimmedString(configDefaults.defaultThinking),
  });
  if (!discoveredModels) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi returned invalid model data.",
      },
    });
  }
  const catalogModels = hasConfigOverlays
    ? [
        {
          slug: "default",
          name: "OMP config default",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        } satisfies ServerProviderModel,
        ...discoveredModels,
      ]
    : discoveredModels;
  const models = providerModelsFromSettings(
    catalogModels,
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
  if (models.length === 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi returned no models. Run `omp setup` and select a model.",
      },
    });
  }
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );

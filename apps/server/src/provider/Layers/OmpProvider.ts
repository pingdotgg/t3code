import type {
  OmpSettings,
  ModelCapabilities,
  ProviderOptionSelection,
  ServerProvider,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";

const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const OMP_CLI_DOCS_URL = "https://github.com/can1357/oh-my-pi";
const OMP_ACP_MODEL_DISCOVERY_FAILED_MESSAGE = [
  "Oh My Pi ACP model discovery failed.",
  "The omp CLI setup may be incomplete; install or enable the omp CLI, restart T3 Code, and try again.",
  `See ${OMP_CLI_DOCS_URL}.`,
  "Check server logs for ACP details.",
].join(" ");

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getOmpFallbackModels(ompSettings);

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Oh My Pi is disabled in T3 Code settings.",
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
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Oh My Pi availability...",
      },
    });
  });
}

interface OmpSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<OmpSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies OmpSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies OmpSessionSelectOption,
        ),
  );
}

function normalizeOmpReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "off":
    case "none":
      return "off";
    // omp's thinking select legitimately offers {off, auto} on auto models.
    case "auto":
      return "auto";
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function getOmpConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isOmpEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (getOmpConfigOptionCategory(option) === "thought_level") {
    return true;
  }
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    id === "thinking" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findOmpEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isOmpEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getOmpConfigOptionCategory(option) === "thought_level") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getOmpConfigOptionCategory(option) === "model_option") ??
    candidates[0]
  );
}

function isOmpContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isOmpFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function isBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") {
    return true;
  }
  if (option.type !== "select") {
    return false;
  }
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) => entry.value.trim().toLowerCase()),
  );
  return values.has("true") && values.has("false");
}

function getBooleanCurrentValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): boolean | undefined {
  if (!option) {
    return undefined;
  }
  if (option.type === "boolean") {
    return option.currentValue;
  }
  if (option.type !== "select") {
    return undefined;
  }
  const normalized = option.currentValue?.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

export function buildOmpCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const reasoningConfig = findOmpEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeOmpReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeOmpReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isOmpContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => {
          if (contextOption.currentValue === entry.value) {
            return {
              value: entry.value,
              label: entry.name,
              isDefault: true,
            };
          }
          return {
            value: entry.value,
            label: entry.name,
          };
        })
      : [];

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isOmpFastConfigOption(option),
  );
  const fastCurrentValue = getBooleanCurrentValue(fastOption);
  const optionDescriptors = [
    ...(reasoningEffortLevels.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: reasoningConfig?.name?.trim() || "Reasoning",
            options: reasoningEffortLevels,
          }),
        ]
      : []),
    ...(contextWindowOptions.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "contextWindow",
            label: contextOption?.name?.trim() || "Context Window",
            options: contextWindowOptions,
          }),
        ]
      : []),
    ...(fastOption && isBooleanLikeConfigOption(fastOption)
      ? [
          typeof fastCurrentValue === "boolean"
            ? buildBooleanOptionDescriptor({
                id: "fastMode",
                label: fastOption.name?.trim() || "Fast Mode",
                currentValue: fastCurrentValue,
              })
            : buildBooleanOptionDescriptor({
                id: "fastMode",
                label: fastOption.name?.trim() || "Fast Mode",
              }),
        ]
      : []),
  ];

  return createModelCapabilities({
    optionDescriptors,
  });
}

function findOmpModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return (
    configOptions.find(
      (option) => option.type === "select" && getOmpConfigOptionCategory(option) === "model",
    ) ??
    configOptions.find(
      (option) => option.type === "select" && option.id.trim().toLowerCase() === "model",
    )
  );
}

function titleCaseSlug(value: string): string {
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

/**
 * Oh My Pi is a meta provider (like OpenCode): model ids advertised through
 * the ACP `model` config option are `provider/model` pairs routed to upstream
 * providers the user configured inside omp. Mirror OpenCode's presentation
 * by surfacing the upstream provider as `subProvider` and sorting the catalog
 * by display name so the picker stays usable with 100+ entries.
 */
function buildOmpDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = findOmpModelConfigOption(configOptions ?? []);
  if (!modelOption) {
    return [];
  }
  const capabilities = buildOmpCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  const models = flattenSessionConfigSelectOptions(modelOption).flatMap((entry) => {
    if (!entry.value || seen.has(entry.value)) {
      return [];
    }
    seen.add(entry.value);
    const slashIndex = entry.value.indexOf("/");
    const subProvider =
      slashIndex > 0 ? titleCaseSlug(entry.value.slice(0, slashIndex)) : undefined;
    return [
      {
        slug: entry.value,
        name: entry.name || entry.value,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function countOmpUpstreamProviders(models: ReadonlyArray<ServerProviderModel>): number {
  const prefixes = new Set<string>();
  for (const model of models) {
    const slashIndex = model.slug.indexOf("/");
    if (slashIndex > 0) {
      prefixes.add(model.slug.slice(0, slashIndex));
    }
  }
  return prefixes.size;
}

const makeOmpAcpProbeRuntime = (ompSettings: OmpSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: ompSettings.binaryPath || "omp",
          args: ["acp"],
          cwd: process.cwd(),
          ...(environment ? { env: environment } : {}),
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        authMethodId: "agent",
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export const discoverOmpModelsViaAcp = (
  ompSettings: OmpSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  makeOmpAcpProbeRuntime(ompSettings, environment).pipe(
    Effect.flatMap((acp) =>
      Effect.map(acp.start(), (started) =>
        buildOmpDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions),
      ),
    ),
    Effect.scoped,
  );

export function getOmpFallbackModels(
  ompSettings: Pick<OmpSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], ompSettings.customModels, EMPTY_CAPABILITIES);
}

function normalizeOmpConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findOmpSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: OmpSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findOmpBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findOmpSelectOptionValue(
    configOption,
    (option) => normalizeOmpConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveOmpAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{
    readonly configId: string;
    readonly value: string | boolean;
  }> = [];

  const reasoningOption = findOmpEffortConfigOption(configOptions);
  const requestedReasoning = normalizeOmpReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (reasoningOption && requestedReasoning) {
    const value = findOmpSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeOmpReasoningValue(option.value);
      const normalizedName = normalizeOmpReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isOmpContextConfigOption(option),
  );
  const requestedContextWindow = getProviderOptionStringSelectionValue(selections, "contextWindow");
  if (contextOption && requestedContextWindow) {
    const value = findOmpSelectOptionValue(
      contextOption,
      (option) =>
        normalizeOmpConfigOptionToken(option.value) ===
          normalizeOmpConfigOptionToken(requestedContextWindow) ||
        normalizeOmpConfigOptionToken(option.name) ===
          normalizeOmpConfigOptionToken(requestedContextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isOmpFastConfigOption(option),
  );
  const requestedFastMode = getProviderOptionBooleanSelectionValue(selections, "fastMode");
  if (fastOption && typeof requestedFastMode === "boolean") {
    const value = findOmpBooleanConfigValue(fastOption, requestedFastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  return updates;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts: Array<string> = [];
  for (const message of messages) {
    const trimmed = message?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildOmpCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Oh My Pi CLI command \`${binaryPath}\` was not found.`,
    `Install or enable the omp CLI, make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
    `See ${OMP_CLI_DOCS_URL}.`,
  ].join(" ");
}

export function buildOmpProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly ompSettings: OmpSettings;
  readonly version: string | null;
  readonly status?: Exclude<ServerProviderState, "disabled">;
  readonly message?: string;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const status = input.status ?? "ready";
  const message = joinProviderMessages(input.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: input.ompSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      input.ompSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.version,
      status: input.discoveryWarning && status === "ready" ? "warning" : status,
      auth: { status: "unknown" },
      ...(message ? { message } : {}),
    },
  });
}

const runOmpVersionCommand = (ompSettings: OmpSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      ...(environment ? { env: environment } : {}),
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(environment ? { env: environment } : { extendEnv: true }),
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getOmpFallbackModels(ompSettings);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Oh My Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runOmpVersionCommand(ompSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Oh My Pi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? buildOmpCliCommandMissingMessage(ompSettings.binaryPath || "omp")
          : "Failed to execute Oh My Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionProbe.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Oh My Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but failed to run.",
      },
    });
  }

  let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
  let discoveryWarning: string | undefined;
  const discoveryExit = yield* Effect.exit(
    discoverOmpModelsViaAcp(ompSettings, environment).pipe(
      Effect.timeoutOption(OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    ),
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Oh My Pi ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    discoveryWarning = OMP_ACP_MODEL_DISCOVERY_FAILED_MESSAGE;
  } else if (Option.isNone(discoveryExit.value)) {
    discoveryWarning = `Oh My Pi ACP model discovery timed out after ${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
  } else if (discoveryExit.value.value.length === 0) {
    discoveryWarning = "Oh My Pi ACP model discovery returned no built-in models.";
  } else {
    discoveredModels = discoveryExit.value;
  }
  const resolvedModels = Option.getOrElse(
    Option.filter(discoveredModels, (models) => models.length > 0),
    () => [] as const,
  );
  // Meta-provider reporting (mirrors OpenCode): tell the user how many
  // upstream providers the discovered `provider/model` catalog routes to.
  const upstreamCount = countOmpUpstreamProviders(resolvedModels);
  return buildOmpProviderSnapshot({
    checkedAt,
    ompSettings,
    version,
    discoveredModels: resolvedModels,
    ...(upstreamCount > 0
      ? {
          message: `${upstreamCount} upstream provider${upstreamCount === 1 ? "" : "s"} configured through Oh My Pi.`,
        }
      : {}),
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});

/**
 * Background maintenance enrichment for an Oh My Pi snapshot.
 *
 * Used by `OmpDriver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: republishes update/version advisory metadata without performing any
 * model or capability discovery. Oh My Pi model data comes exclusively from
 * the probe ACP session during provider status checks.
 */
export const enrichOmpSnapshot = (input: {
  readonly settings: OmpSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  if (!settings.enabled || snapshot.auth.status === "unauthenticated") {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};

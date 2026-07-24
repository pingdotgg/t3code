import {
  type KimiSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
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
import { makeKimiAcpRuntime, resolveKimiAcpBaseModelId } from "../acp/KimiAcpSupport.ts";
import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
} from "../acp/AcpRuntimeModel.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const PROVIDER = ProviderDriverKind.make("kimi");
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const KIMI_K3_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Thinking",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
        { id: "max", label: "Max" },
      ],
      currentValue: "high",
    },
  ],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

function isKimiK3Slug(slug: string | null | undefined): boolean {
  return !!slug && (slug.includes("/k3") || slug.endsWith("k3"));
}

const KIMI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-code/k3",
    name: "K3",
    isCustom: false,
    capabilities: KIMI_K3_CAPABILITIES,
  },
  {
    slug: "kimi-code/kimi-for-coding",
    name: "K2.7 Coding",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "kimi-code/kimi-for-coding-highspeed",
    name: "K2.7 Coding Highspeed",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

// Best-known context windows per public Moonshot docs: K3 advertises up to
// 1M tokens; the K2.7 "for coding" line uses 256K. ACP `usage_update`
// notifications report the window size directly and take precedence — this
// map is the fallback for turn-level `PromptResponse.usage`, which carries
// token counts but no window size. Unknown/custom slugs intentionally have no
// entry so the UI falls back to a raw token count instead of a wrong limit.
const KIMI_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "kimi-code/k3": 1_048_576,
  "kimi-code/kimi-for-coding": 262_144,
  "kimi-code/kimi-for-coding-highspeed": 262_144,
};

export function kimiContextWindowForModel(slug: string | null | undefined): number | undefined {
  if (!slug) {
    return undefined;
  }
  return KIMI_MODEL_CONTEXT_WINDOWS[slug];
}

/**
 * Builds the shared token-usage snapshot from an ACP `Usage` payload (turn
 * level, e.g. `PromptResponse.usage`). The window limit comes from
 * `kimiContextWindowForModel` because ACP turn usage carries token counts but
 * no window size; streaming `usage_update` notifications report `size`
 * directly and do not go through this helper.
 */
export function kimiTokenUsageSnapshotFromAcpUsage(
  usage: EffectAcpSchema.Usage | null | undefined,
  modelSlug: string | null | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage || usage.totalTokens <= 0) {
    return undefined;
  }
  const maxTokens = kimiContextWindowForModel(modelSlug);
  const cachedReadTokens =
    typeof usage.cachedReadTokens === "number" && usage.cachedReadTokens > 0
      ? usage.cachedReadTokens
      : undefined;
  const cachedWriteTokens =
    typeof usage.cachedWriteTokens === "number" && usage.cachedWriteTokens > 0
      ? usage.cachedWriteTokens
      : undefined;
  const thoughtTokens =
    typeof usage.thoughtTokens === "number" && usage.thoughtTokens > 0
      ? usage.thoughtTokens
      : undefined;
  return {
    usedTokens: usage.totalTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
    ...(cachedReadTokens !== undefined
      ? { cachedInputTokens: cachedReadTokens, cacheReadInputTokens: cachedReadTokens }
      : {}),
    ...(cachedWriteTokens !== undefined ? { cacheCreationInputTokens: cachedWriteTokens } : {}),
    ...(usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {}),
    ...(thoughtTokens !== undefined ? { reasoningOutputTokens: thoughtTokens } : {}),
    accountingStatus: "provider-reported",
  };
}

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kimiModelsFromSettings(kimiSettings.customModels);

    if (!kimiSettings.enabled) {
      return buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimi CLI availability...",
      },
    });
  });
}

function kimiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIMI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function buildKimiDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIMI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const modelConfigId =
    extractModelConfigId({ configOptions }) ??
    findSessionConfigOption(configOptions, "model")?.id ??
    "model";
  const modelOption = findSessionConfigOption(configOptions, modelConfigId);
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }

  const thinkingOption = findSessionConfigOption(configOptions, "thinking");
  const thinkingValues =
    thinkingOption && thinkingOption.type === "select"
      ? collectSessionConfigOptionValues(thinkingOption)
      : [];
  const thinkingCapabilities: ModelCapabilities =
    thinkingValues.length > 0
      ? createModelCapabilities({
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Thinking",
              type: "select",
              options: thinkingValues.map((id) => ({
                id,
                label: id.charAt(0).toUpperCase() + id.slice(1),
                ...(id ===
                (typeof thinkingOption?.currentValue === "string"
                  ? thinkingOption.currentValue
                  : "high")
                  ? { isDefault: true }
                  : {}),
              })),
              ...(typeof thinkingOption?.currentValue === "string"
                ? { currentValue: thinkingOption.currentValue }
                : {}),
            },
          ],
        })
      : EMPTY_CAPABILITIES;

  const builtInBySlug = new Map(builtInModels.map((model) => [model.slug, model] as const));
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  const selectEntries = modelOption.options.flatMap((entry) =>
    "value" in entry ? [entry] : entry.options,
  );

  // The CLI's `thinking` option reflects the session's *current* model: K2.7
  // models advertise on/off, while K3 advertises low/high/max. The discovery
  // probe starts on whatever model the CLI defaults to, so only trust the
  // advertised thinking values for K3 when K3 is the current model; otherwise
  // fall back to the known K3 effort levels.
  const currentModelSlug = resolveKimiAcpBaseModelId(
    typeof modelOption.currentValue === "string" ? modelOption.currentValue : undefined,
  );
  const currentModelIsK3 = isKimiK3Slug(currentModelSlug);

  for (const option of selectEntries) {
    const slug = resolveKimiAcpBaseModelId(option.value);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const builtIn = builtInBySlug.get(slug);
    // K3 is the only model that currently advertises thinking efforts.
    const supportsThinking = isKimiK3Slug(slug);
    models.push({
      slug,
      name: option.name.trim() || builtIn?.name || slug,
      isCustom: false,
      capabilities: supportsThinking
        ? currentModelIsK3 && thinkingValues.length > 0
          ? thinkingCapabilities
          : KIMI_K3_CAPABILITIES
        : (builtIn?.capabilities ?? EMPTY_CAPABILITIES),
    });
  }

  return models;
}

const discoverKimiModelsViaAcp = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeKimiAcpRuntime({
      kimiSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const fromModels = started.sessionSetupResult.models;
    if (fromModels && fromModels.availableModels.length > 0) {
      return fromModels.availableModels.map(
        (model): ServerProviderModel => ({
          slug: resolveKimiAcpBaseModelId(model.modelId),
          name: model.name.trim() || model.modelId,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        }),
      );
    }
    return buildKimiDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions);
  }).pipe(Effect.scoped);

const runKimiVersionCommand = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = kimiSettings.binaryPath || "kimi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kimiModelsFromSettings(kimiSettings.customModels);

  if (!kimiSettings.enabled) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runKimiVersionCommand(kimiSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kimi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kimi Code CLI (`kimi`) is not installed or not on PATH."
          : "Failed to execute Kimi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but timed out while running `kimi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kimi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverKimiModelsViaAcp(kimiSettings, environment).pipe(
    Effect.timeoutOption(KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Kimi ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Kimi Code CLI is installed but ACP startup failed. Run `kimi login` and check server logs.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Kimi ACP model discovery timed out after ${KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Kimi Code CLI is installed but ACP startup timed out after ${KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discoveredModels = discoveryExit.value.value;
  const models =
    discoveredModels.length > 0
      ? kimiModelsFromSettings(kimiSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: kimiSettings.enabled,
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

export const enrichKimiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

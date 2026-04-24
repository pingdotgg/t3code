import type {
  CopilotSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { Cause, Effect, Equal, Exit, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsError } from "@t3tools/contracts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { makeCopilotAcpRuntime } from "../acp/CopilotAcpSupport.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { CopilotProvider } from "../Services/CopilotProvider.ts";

const PROVIDER = "copilot" as const;
const COPILOT_REFRESH_INTERVAL = "1 hour";
const COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 12_000;

const DEFAULT_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 mini",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
];

interface CopilotSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<CopilotSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies CopilotSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies CopilotSessionSelectOption,
        ),
  );
}

function findCopilotModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return (
    configOptions.find((option) => option.category?.trim().toLowerCase() === "model") ??
    configOptions.find((option) => option.id.trim().toLowerCase() === "model")
  );
}

function findCopilotReasoningConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return (
    configOptions.find((option) => option.id.trim().toLowerCase() === "reasoning_effort") ??
    configOptions.find((option) => option.category?.trim().toLowerCase() === "thought_level")
  );
}

function buildCopilotCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return DEFAULT_COPILOT_MODEL_CAPABILITIES;
  }
  const reasoningOption = findCopilotReasoningConfigOption(configOptions);
  const currentReasoningValue =
    reasoningOption?.type === "select" ? reasoningOption.currentValue?.trim() : undefined;
  const reasoningEffortLevels =
    reasoningOption?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningOption)
          .filter((entry) => entry.value.length > 0)
          .map((entry) => ({
            value: entry.value,
            label: entry.name.length > 0 ? entry.name : entry.value,
            ...(currentReasoningValue === entry.value ? { isDefault: true } : {}),
          }))
      : [];
  return {
    ...DEFAULT_COPILOT_MODEL_CAPABILITIES,
    reasoningEffortLevels,
  };
}

function buildCopilotDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }
  const modelOption = findCopilotModelConfigOption(configOptions);
  const modelChoices = flattenSessionConfigSelectOptions(modelOption);
  if (!modelOption || modelChoices.length === 0) {
    return [];
  }
  const capabilities = buildCopilotCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  return modelChoices.flatMap((choice) => {
    const slug = choice.value.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: choice.name.trim() || slug,
        isCustom: false,
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

const withCopilotAcpProbeRuntime = <A, E, R>(
  copilotSettings: CopilotSettings,
  useRuntime: (runtime: AcpSessionRuntimeShape) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeCopilotAcpRuntime({
      childProcessSpawner: spawner,
      copilotSettings,
      cwd: process.cwd(),
      clientInfo: {
        name: "t3-code-provider-probe",
        version: "0.0.0",
      },
    });
    return yield* useRuntime(runtime);
  }).pipe(Effect.scoped);

export const discoverCopilotModelsViaAcp = (copilotSettings: CopilotSettings) =>
  withCopilotAcpProbeRuntime(copilotSettings, (acp) =>
    Effect.map(acp.start(), (started) =>
      buildCopilotDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
    ),
  );

function getCopilotModels(
  settings: Pick<CopilotSettings, "customModels">,
  discoveredBuiltInModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    discoveredBuiltInModels,
    PROVIDER,
    settings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );
}

function buildInitialCopilotProviderSnapshot(copilotSettings: CopilotSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = getCopilotModels(copilotSettings, FALLBACK_MODELS);
  if (!copilotSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot CLI availability...",
    },
  });
}

const runCopilotVersionCommand = (binaryPath: string) =>
  spawnAndCollect(binaryPath, ChildProcess.make(binaryPath, ["--version"], { shell: false }));

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.copilot),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = getCopilotModels(copilotSettings, FALLBACK_MODELS);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    const probeResult = yield* Effect.exit(runCopilotVersionCommand(copilotSettings.binaryPath));
    if (Exit.isFailure(probeResult)) {
      const cause = Cause.squash(probeResult.cause);
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
            : `Failed to execute GitHub Copilot CLI health check: ${error.message}.`,
        },
      });
    }

    const output = `${probeResult.value.stdout}\n${probeResult.value.stderr}`;
    const version = parseGenericCliVersion(output);
    if (probeResult.value.code !== 0) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message:
            detailFromResult(probeResult.value) ??
            "GitHub Copilot CLI responded with a non-zero exit code.",
        },
      });
    }

    let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
    let discoveryWarning: string | undefined;
    const discoveryExit = yield* Effect.exit(
      discoverCopilotModelsViaAcp(copilotSettings).pipe(
        Effect.timeoutOption(COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("Copilot ACP model discovery failed", {
        cause: Cause.pretty(discoveryExit.cause),
      });
      discoveryWarning = "Copilot ACP model discovery failed. Check server logs for details.";
    } else if (Option.isNone(discoveryExit.value)) {
      discoveryWarning = `Copilot ACP model discovery timed out after ${COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
    } else if (discoveryExit.value.value.length === 0) {
      discoveryWarning = "Copilot ACP model discovery returned no built-in models.";
    } else {
      discoveredModels = discoveryExit.value;
    }
    const models = getCopilotModels(
      copilotSettings,
      Option.getOrElse(
        Option.filter(discoveredModels, (entries) => entries.length > 0),
        () => FALLBACK_MODELS,
      ),
    );

    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: discoveryWarning ? "warning" : "ready",
        auth: { status: "unknown" },
        ...(discoveryWarning ? { message: discoveryWarning } : {}),
      },
    });
  },
);

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkCopilotProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: buildInitialCopilotProviderSnapshot,
      checkProvider,
      refreshInterval: COPILOT_REFRESH_INTERVAL,
    });
  }),
);

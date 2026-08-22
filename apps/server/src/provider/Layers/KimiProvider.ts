import {
  type KimiSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
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
import { makeKimiAcpRuntime, resolveKimiAcpBaseModelId } from "../acp/KimiAcpSupport.ts";
import { collectSessionConfigOptionValues } from "../acp/AcpRuntimeModel.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** Default Thinking levels when ACP discovery is unavailable (Kimi K3 family). */
const DEFAULT_THINKING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "reasoning",
      label: "Thinking",
      options: [
        { value: "low", label: "Low" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
      ],
    }),
  ],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Catalog fallback when ACP discovery is unavailable.
 * Wire IDs must use the `kimi-code/` provider prefix that `kimi acp` advertises
 * on `session/set_model` / `session/set_config_option` (bare ids return Internal error).
 */
const KIMI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-code/k3",
    name: "Kimi K3",
    isCustom: false,
    capabilities: DEFAULT_THINKING_CAPABILITIES,
  },
  {
    slug: "kimi-code/k3-256k",
    name: "Kimi K3 256K",
    isCustom: false,
    capabilities: DEFAULT_THINKING_CAPABILITIES,
  },
  {
    slug: "kimi-code/kimi-for-coding",
    name: "Kimi K2.7 Code",
    isCustom: false,
    capabilities: DEFAULT_THINKING_CAPABILITIES,
  },
  {
    slug: "kimi-code/kimi-for-coding-highspeed",
    name: "Kimi K2.7 Code HighSpeed",
    isCustom: false,
    capabilities: DEFAULT_THINKING_CAPABILITIES,
  },
];

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
    customModels ?? [],
    DEFAULT_THINKING_CAPABILITIES,
  );
}

function buildKimiThinkingCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return DEFAULT_THINKING_CAPABILITIES;
  }
  const thinkingOption = configOptions.find(
    (option) =>
      option.id === "thinking" ||
      option.category === "thought_level" ||
      option.name?.trim().toLowerCase() === "thinking",
  );
  if (!thinkingOption || thinkingOption.type !== "select") {
    return DEFAULT_THINKING_CAPABILITIES;
  }
  const values = collectSessionConfigOptionValues(thinkingOption);
  if (values.length === 0) {
    return DEFAULT_THINKING_CAPABILITIES;
  }
  const current =
    typeof thinkingOption.currentValue === "string" ? thinkingOption.currentValue.trim() : "";
  const labelsByValue = new Map<string, string>();
  for (const entry of thinkingOption.options) {
    if ("value" in entry && typeof entry.value === "string") {
      labelsByValue.set(entry.value, entry.name?.trim() || entry.value);
    } else if ("options" in entry) {
      for (const nested of entry.options) {
        labelsByValue.set(nested.value, nested.name?.trim() || nested.value);
      }
    }
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoning",
        label: thinkingOption.name?.trim() || "Thinking",
        options: values.map((value) => ({
          value,
          label: labelsByValue.get(value) ?? value,
          ...(current === value ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

function buildKimiDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }
  const modelOption = configOptions.find(
    (option) => option.id === "model" || option.category === "model",
  );
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }
  const capabilities = buildKimiThinkingCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  // ACP select options may be flat `{ value }` entries or grouped
  // `{ options: [...] }` entries — flatten groups the same way thinking does.
  const flatEntries = modelOption.options.flatMap((entry) =>
    "options" in entry && Array.isArray(entry.options) ? entry.options : [entry],
  );
  return flatEntries.flatMap((entry): Array<ServerProviderModel> => {
    if (!("value" in entry) || typeof entry.value !== "string") {
      return [];
    }
    const slug = resolveKimiAcpBaseModelId(entry.value);
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    const name =
      "name" in entry && typeof entry.name === "string" && entry.name.trim().length > 0
        ? entry.name.trim()
        : slug;
    return [
      {
        slug,
        name,
        isCustom: false,
        capabilities,
      },
    ];
  });
}

function buildKimiDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  capabilities: ModelCapabilities = DEFAULT_THINKING_CAPABILITIES,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveKimiAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
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
    const configOptions = started.sessionSetupResult.configOptions ?? [];
    const capabilities = buildKimiThinkingCapabilitiesFromConfigOptions(configOptions);
    const fromConfig = buildKimiDiscoveredModelsFromConfigOptions(configOptions);
    if (fromConfig.length > 0) {
      return fromConfig;
    }
    return buildKimiDiscoveredModelsFromSessionModelState(
      started.sessionSetupResult.models,
      capabilities,
    );
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
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
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
        message: "Kimi CLI is installed but timed out while running `kimi --version`.",
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
        message: "Kimi CLI is installed but failed to run.",
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
          "Kimi CLI is installed but ACP startup failed. Run `kimi` and `/login` once, then retry.",
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
        message: `Kimi CLI is installed but ACP startup timed out after ${KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
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

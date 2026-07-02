import {
  type DevinSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildBooleanOptionDescriptor,
  buildServerProvider,
  buildSelectOptionDescriptor,
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
import {
  DEVIN_REASONING_LEVEL_LABELS,
  DEVIN_REASONING_LEVEL_ORDER,
  devinAcpModelVariantGroupsFromConfigOptions,
  devinContextWindowKeyForVariant,
  devinModelConfigOptionsFromSessionSetup,
  devinReasoningKeyForVariant,
  resolveDevinAcpBaseModelId,
  type DevinAcpModelVariantGroup,
} from "../acp/DevinAcpSupport.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
const PROVIDER = ProviderDriverKind.make("devin");
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "adaptive",
    name: "Adaptive",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "swe",
    name: "SWE",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "opus",
    name: "Opus",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "sonnet",
    name: "Sonnet",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "codex",
    name: "Codex",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini",
    name: "Gemini",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

function buildDevinDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveDevinAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

function uniqueSortedDevinReasoningLevels(group: DevinAcpModelVariantGroup) {
  const levels = new Set(group.variants.map(devinReasoningKeyForVariant));
  return DEVIN_REASONING_LEVEL_ORDER.filter((level) => levels.has(level));
}

function buildDevinCapabilitiesForVariantGroup(group: DevinAcpModelVariantGroup) {
  const defaultVariant = group.currentVariant ?? group.variants[0];
  const reasoningLevels = uniqueSortedDevinReasoningLevels(group);
  const contextWindows = Array.from(new Set(group.variants.map(devinContextWindowKeyForVariant)));
  const hasFastVariants = group.variants.some((variant) => variant.fastMode);
  const hasNormalSpeedVariants = group.variants.some((variant) => !variant.fastMode);

  const optionDescriptors = [
    ...(reasoningLevels.length > 1 && defaultVariant
      ? [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: "Thinking",
            options: reasoningLevels.map((level) => ({
              value: level,
              label: DEVIN_REASONING_LEVEL_LABELS[level],
              ...(devinReasoningKeyForVariant(defaultVariant) === level ? { isDefault: true } : {}),
            })),
          }),
        ]
      : []),
    ...(contextWindows.length > 1 && defaultVariant
      ? [
          buildSelectOptionDescriptor({
            id: "contextWindow",
            label: "Context Window",
            options: contextWindows
              .sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)))
              .map((contextWindow) => ({
                value: contextWindow,
                label: contextWindow === "default" ? "Default" : contextWindow.toUpperCase(),
                ...(devinContextWindowKeyForVariant(defaultVariant) === contextWindow
                  ? { isDefault: true }
                  : {}),
              })),
          }),
        ]
      : []),
    ...(hasFastVariants && hasNormalSpeedVariants
      ? [
          buildBooleanOptionDescriptor({
            id: "fastMode",
            label: "Fast Mode",
            currentValue: defaultVariant?.fastMode === true,
          }),
        ]
      : []),
  ];

  return createModelCapabilities({ optionDescriptors });
}

function buildDevinDiscoveredModelsFromConfigOptions(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const groups = devinAcpModelVariantGroupsFromConfigOptions(sessionSetupResult.configOptions);
  if (groups.length > 0) {
    return groups
      .map((group): ServerProviderModel | undefined => {
        const slug = group.baseModelId.trim();
        if (!slug || seen.has(slug)) {
          return undefined;
        }
        seen.add(slug);
        return {
          slug,
          name: group.baseModelName.trim() || slug,
          isCustom: false,
          capabilities: buildDevinCapabilitiesForVariantGroup(group),
        };
      })
      .filter((model): model is ServerProviderModel => model !== undefined);
  }

  return devinModelConfigOptionsFromSessionSetup(sessionSetupResult)
    .map((option): ServerProviderModel | undefined => {
      const slug = option.value.trim();
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: option.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

export function buildDevinDiscoveredModelsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const configModels = buildDevinDiscoveredModelsFromConfigOptions(sessionSetupResult);
  return configModels.length > 0
    ? configModels
    : buildDevinDiscoveredModelsFromSessionModelState(sessionSetupResult.models);
}

const runDevinVersionCommand = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, ["version"], {
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

export interface DevinProviderStatusOptions {
  readonly cachedDiscoveredModels?: ReadonlyArray<ServerProviderModel>;
}

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: DevinProviderStatusOptions,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);
  const cachedModels = options?.cachedDiscoveredModels ?? [];
  const models =
    cachedModels.length > 0
      ? devinModelsFromSettings(devinSettings.customModels, cachedModels)
      : fallbackModels;

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinVersionCommand(devinSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
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

export const enrichDevinSnapshot = (input: {
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
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

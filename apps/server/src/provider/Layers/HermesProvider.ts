import {
  type HermesSettings,
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { HERMES_DEFAULT_MODEL, makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";

const PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_DISCOVERY_TIMEOUT_MS = 15_000;

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: HERMES_DEFAULT_MODEL,
    name: "Hermes default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function fallbackModels(settings: HermesSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(FALLBACK_MODELS, settings.customModels, EMPTY_CAPABILITIES);
}

function flattenSelectOptions(
  option: Extract<EffectAcpSchema.SessionConfigOption, { type: "select" }>,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  return option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

export function buildHermesCapabilitiesFromConfigOptions(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!options?.length) return EMPTY_CAPABILITIES;
  const optionDescriptors: ProviderOptionDescriptor[] = [];
  for (const option of options) {
    if (option.id === "mode" || option.id === "model") {
      continue;
    }
    if (!option.id.trim() || !option.name.trim()) {
      continue;
    }
    const description = option.description?.trim() ? option.description : undefined;
    if (option.type === "boolean") {
      optionDescriptors.push({
        id: option.id,
        label: option.name,
        type: "boolean",
        currentValue: option.currentValue,
        ...(description ? { description } : {}),
      });
      continue;
    }
    const choices = flattenSelectOptions(option).flatMap((choice) => {
      if (!choice.value.trim() || !choice.name.trim()) return [];
      const choiceDescription = choice.description?.trim() ? choice.description : undefined;
      return [
        {
          id: choice.value,
          label: choice.name,
          ...(choiceDescription ? { description: choiceDescription } : {}),
          ...(option.currentValue === choice.value ? { isDefault: true } : {}),
        },
      ];
    });
    if (choices.length > 0) {
      optionDescriptors.push({
        id: option.id,
        label: option.name,
        type: "select",
        options: choices,
        ...(option.currentValue.trim() ? { currentValue: option.currentValue } : {}),
        ...(description ? { description } : {}),
      });
    }
  }
  return createModelCapabilities({
    optionDescriptors,
  });
}

export function buildHermesDiscoveredModels(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  configOptionsByModel: ReadonlyMap<string, ReadonlyArray<EffectAcpSchema.SessionConfigOption>>,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState?.availableModels.length) return [];
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model) => {
    const slug = model.modelId;
    if (!slug.trim() || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() ? model.name : slug,
        isCustom: false,
        capabilities: buildHermesCapabilitiesFromConfigOptions(configOptionsByModel.get(slug)),
      } satisfies ServerProviderModel,
    ];
  });
}

export const discoverHermesModelsFromAcpSession = Effect.fn("discoverHermesModelsFromAcpSession")(
  function* (input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setSessionModel"
    >;
    readonly sessionSetupResult:
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse;
  }) {
    const modelState = input.sessionSetupResult.models;
    if (!modelState?.availableModels.length) {
      return [];
    }

    const configOptionsByModel = new Map<
      string,
      ReadonlyArray<EffectAcpSchema.SessionConfigOption>
    >();
    const currentModelId = modelState.currentModelId;
    if (currentModelId.trim()) {
      configOptionsByModel.set(currentModelId, input.sessionSetupResult.configOptions ?? []);
    }

    for (const model of modelState.availableModels) {
      const modelId = model.modelId;
      if (!modelId.trim() || configOptionsByModel.has(modelId)) {
        continue;
      }
      yield* input.runtime.setSessionModel(modelId);
      configOptionsByModel.set(modelId, yield* input.runtime.getConfigOptions);
    }

    return buildHermesDiscoveredModels(modelState, configOptionsByModel);
  },
);

export const makePendingHermesProvider = Effect.fn("makePendingHermesProvider")(function* (
  settings: HermesSettings,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: fallbackModels(settings),
    probe: settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Hermes CLI and ACP availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
  });
});

const runHermesVersionCommand = (settings: HermesSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "hermes";
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

const discoverHermesModelsViaAcp = (settings: HermesSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings: settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return yield* discoverHermesModelsFromAcpSession({
      runtime: acp,
      sessionSetupResult: started.sessionSetupResult,
    });
  }).pipe(Effect.scoped);

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  settings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbacks = fallbackModels(settings);
  if (!settings.enabled) return yield* makePendingHermesProvider(settings);

  const versionResult = yield* runHermesVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbacks,
      probe: {
        installed: !isCommandMissingCause(versionResult.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(versionResult.failure)
          ? "Hermes CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute the Hermes CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbacks,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI timed out while running `hermes --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbacks,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverHermesModelsViaAcp(settings, environment).pipe(
    Effect.timeoutOption(ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Hermes ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbacks,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message:
          "Hermes ACP startup failed. Configure a model/provider with `hermes model`, then try again.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbacks,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Hermes ACP startup timed out after ${ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovered = discoveryExit.value.value;
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models:
      discovered.length > 0
        ? providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES)
        : fallbacks,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: {
        status: "authenticated",
        type: "hermes-runtime",
        label: "Hermes runtime credentials",
      },
      message: "Hermes ACP is ready.",
    },
  });
});

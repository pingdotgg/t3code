import {
  ProviderDriverKind,
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  parsePiModelList,
  PI_THINKING_LEVELS,
  piRuntimeErrorDetail,
  runPiCommand,
  type PiModelInfo,
} from "../piRuntime.ts";
import {
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PI_THINKING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "thinking",
      label: "Thinking",
      type: "select",
      options: PI_THINKING_LEVELS.map((level) =>
        level === "medium"
          ? { id: level, label: titleCase(level), isDefault: true as const }
          : { id: level, label: titleCase(level) },
      ),
      currentValue: "medium",
    },
  ],
});

function titleCase(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function toServerProviderModels(models: ReadonlyArray<PiModelInfo>): Array<ServerProviderModel> {
  return models
    .map((model) => ({
      slug: `${model.provider}/${model.modelId}`,
      name: model.modelId,
      subProvider: model.provider,
      isCustom: false,
      capabilities: model.thinking ? PI_THINKING_CAPABILITIES : DEFAULT_PI_MODEL_CAPABILITIES,
    }))
    .toSorted((left, right) => left.slug.localeCompare(right.slug));
}

function formatPiProbeError(detail: string): { installed: boolean; message: string } {
  const lower = detail.toLowerCase();
  if (lower.includes("enoent") || lower.includes("notfound") || lower.includes("not found")) {
    return {
      installed: false,
      message: "Pi CLI (`pi`) is not installed or not on PATH.",
    };
  }
  return {
    installed: true,
    message: `Failed to execute Pi CLI health check: ${detail}`,
  };
}

export const makePendingPiProvider = (piSettings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      PROVIDER,
      piSettings.customModels,
      DEFAULT_PI_MODEL_CAPABILITIES,
    );
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: piSettings.enabled
          ? "Pi provider status has not been checked in this session yet."
          : "Pi is disabled in T3 Code settings.",
      },
    });
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = piSettings.customModels;

  const fallback = (detail: string, version: string | null = null) => {
    const failure = formatPiProbeError(detail);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], PROVIDER, customModels, DEFAULT_PI_MODEL_CAPABILITIES),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], PROVIDER, customModels, DEFAULT_PI_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionExit = yield* Effect.exit(
    runPiCommand({
      binaryPath: piSettings.binaryPath,
      args: ["--version"],
      environment: resolvedEnvironment,
    }),
  );
  if (versionExit._tag === "Failure") {
    return fallback(piRuntimeErrorDetail(versionExit.cause));
  }
  const version = parseGenericCliVersion(versionExit.value.stdout);
  if (!version) {
    return fallback("Unable to determine Pi version from `pi --version` output.");
  }

  const modelsExit = yield* Effect.exit(
    runPiCommand({
      binaryPath: piSettings.binaryPath,
      args: ["--list-models"],
      environment: resolvedEnvironment,
    }),
  );
  if (modelsExit._tag === "Failure") {
    return fallback(piRuntimeErrorDetail(modelsExit.cause), version);
  }

  const piModels = parsePiModelList(modelsExit.value.stdout);
  const models = providerModelsFromSettings(
    toServerProviderModels(piModels),
    PROVIDER,
    customModels,
    DEFAULT_PI_MODEL_CAPABILITIES,
  );

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: piModels.length > 0 ? "ready" : "warning",
      auth: {
        status: piModels.length > 0 ? "authenticated" : "unknown",
        type: "pi",
      },
      message:
        piModels.length > 0
          ? `Pi reports ${piModels.length} models across its configured providers.`
          : "Pi is available, but `pi --list-models` reported no models.",
    },
  });
});

import {
  type AvailableModelConfig,
  createSession,
  type CreateSessionOptions,
  type DroidSession,
  ModelProvider,
  ReasoningEffort,
} from "@factory/droid-sdk";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type DroidSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("droid");
const DROID_PRESENTATION = {
  displayName: "Droid",
  badgeLabel: "WIP",
  showInteractionModeToggle: true,
} as const;
const DROID_CLI_TIMEOUT_MS = 10_000;
const DROID_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  [ReasoningEffort.None]: "None",
  [ReasoningEffort.Dynamic]: "Dynamic",
  [ReasoningEffort.Off]: "Off",
  [ReasoningEffort.Minimal]: "Minimal",
  [ReasoningEffort.Low]: "Low",
  [ReasoningEffort.Medium]: "Medium",
  [ReasoningEffort.High]: "High",
  [ReasoningEffort.ExtraHigh]: "Extra High",
  [ReasoningEffort.Max]: "Max",
};

const DROID_FALLBACK_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "reasoningEffort",
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
    }),
  ],
});

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Factory default",
    shortName: "Default",
    isCustom: false,
    capabilities: DROID_FALLBACK_MODEL_CAPABILITIES,
  },
];

interface DroidProviderSdk {
  readonly createSession: (options?: CreateSessionOptions) => Promise<DroidSession>;
}

interface DroidProviderStatusOptions {
  readonly sdk?: DroidProviderSdk;
}

class DroidModelDiscoveryError extends Data.TaggedError("DroidModelDiscoveryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class DroidModelDiscoveryTimeoutError extends Error {
  constructor() {
    super("Timed out while discovering Droid models.");
    this.name = "DroidModelDiscoveryTimeoutError";
  }
}

export function droidDiscoveryFailureMessage(failure: unknown): string {
  const error = Cause.isCause(failure) ? Cause.squash(failure) : failure;
  return error instanceof Error ? error.message : String(error);
}

const defaultSdk: DroidProviderSdk = { createSession };

const modelProviderLabel = (provider: ModelProvider): string => {
  switch (provider) {
    case ModelProvider.ANTHROPIC:
      return "Anthropic";
    case ModelProvider.OPENAI:
      return "OpenAI";
    case ModelProvider.GENERIC_CHAT_COMPLETION_API:
      return "Custom";
    case ModelProvider.FACTORY:
      return "Factory";
    case ModelProvider.GOOGLE:
      return "Google";
    case ModelProvider.XAI:
      return "xAI";
    case ModelProvider.VOYAGE:
      return "Voyage";
    default:
      return String(provider);
  }
};

const compactEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
};

function droidModelCapabilities(model: AvailableModelConfig) {
  const options = model.supportedReasoningEfforts.map((effort) => ({
    value: effort,
    label: REASONING_EFFORT_LABELS[effort] ?? effort,
    isDefault: effort === model.defaultReasoningEffort,
  }));
  return createModelCapabilities({
    optionDescriptors:
      options.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "reasoningEffort",
              label: "Reasoning",
              options,
            }),
          ]
        : [],
  });
}

function droidAvailableModelToServerModel(model: AvailableModelConfig): ServerProviderModel | null {
  const slug = model.isCustom
    ? (nonEmpty(model.id) ?? nonEmpty(model.modelId))
    : (nonEmpty(model.modelId) ?? nonEmpty(model.id));
  if (!slug) return null;
  const name = nonEmpty(model.displayName) ?? slug;
  const shortName = nonEmpty(model.shortDisplayName);
  return {
    slug,
    name,
    ...(shortName && shortName !== name ? { shortName } : {}),
    subProvider: modelProviderLabel(model.modelProvider),
    isCustom: model.isCustom,
    capabilities: droidModelCapabilities(model),
  };
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function buildDroidModelsFromSdkModels(
  models: ReadonlyArray<AvailableModelConfig> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const resolved: ServerProviderModel[] = [];
  for (const model of models ?? []) {
    const entry = droidAvailableModelToServerModel(model);
    if (!entry || seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    resolved.push(entry);
  }
  return resolved;
}

const discoverDroidModels = (
  settings: DroidSettings,
  environment: NodeJS.ProcessEnv,
  options?: DroidProviderStatusOptions,
): Effect.Effect<ReadonlyArray<ServerProviderModel>, DroidModelDiscoveryError> =>
  Effect.tryPromise({
    try: async (abortSignal) => {
      const controller = new AbortController();
      const timeoutController = new AbortController();
      const onAbort = () => controller.abort(abortSignal.reason);
      abortSignal.addEventListener("abort", onAbort, { once: true });
      let session: DroidSession | undefined;
      let shouldCloseLateSession = false;
      try {
        const sessionPromise = (options?.sdk ?? defaultSdk).createSession({
          cwd: tmpdir(),
          execPath: settings.binaryPath,
          env: compactEnvironment(environment),
          abortSignal: controller.signal,
        });
        sessionPromise
          .then((lateSession) => {
            if (shouldCloseLateSession) {
              void lateSession.close().catch(() => undefined);
            }
          })
          .catch(() => undefined);
        const timeoutPromise = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          });
        });
        const discoveryTimeoutPromise = sleep(DROID_MODEL_DISCOVERY_TIMEOUT_MS, undefined, {
          signal: timeoutController.signal,
        }).then(() => {
          const error = new DroidModelDiscoveryTimeoutError();
          controller.abort(error);
          throw error;
        });
        session = await Promise.race([sessionPromise, timeoutPromise, discoveryTimeoutPromise]);
        return buildDroidModelsFromSdkModels(session.initResult.availableModels);
      } finally {
        shouldCloseLateSession = controller.signal.aborted && session === undefined;
        timeoutController.abort();
        abortSignal.removeEventListener("abort", onAbort);
        if (!shouldCloseLateSession) {
          await session?.close().catch(() => undefined);
        }
      }
    },
    catch: (cause) =>
      new DroidModelDiscoveryError({
        message: cause instanceof Error ? cause.message : "Failed to discover Droid models.",
        cause,
      }),
  });

const modelsWithSettingsFallback = (
  sdkModels: ReadonlyArray<ServerProviderModel>,
  settings: DroidSettings,
): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(
    sdkModels.length > 0 ? sdkModels : FALLBACK_MODELS,
    PROVIDER,
    settings.customModels,
    DROID_FALLBACK_MODEL_CAPABILITIES,
  );

export function makePendingDroidProvider(
  settings: DroidSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = modelsWithSettingsFallback([], settings);

    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Droid availability..."
          : "Droid is disabled in T3 Code settings.",
      },
    });
  });
}

export function checkDroidProviderStatus(
  settings: DroidSettings,
  environment: NodeJS.ProcessEnv,
  options?: DroidProviderStatusOptions,
): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const fallbackModels = modelsWithSettingsFallback([], settings);

    if (!settings.enabled) {
      return yield* makePendingDroidProvider(settings);
    }

    const command = ChildProcess.make(settings.binaryPath, ["--version"], {
      env: environment,
      shell: process.platform === "win32",
    });
    const result = yield* spawnAndCollect(settings.binaryPath, command).pipe(
      Effect.timeoutOption(DROID_CLI_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(result)) {
      const cause = result.failure;
      const message = cause instanceof Error ? cause.message : String(cause);
      return buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause({ message }),
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: isCommandMissingCause({ message })
            ? "Droid CLI (`droid`) is not installed or not on PATH."
            : `Failed to execute Droid CLI health check: ${message}.`,
        },
      });
    }

    if (Option.isNone(result.success)) {
      return buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Timed out while checking Droid CLI availability.",
        },
      });
    }

    const commandResult = result.success.value;
    const detail = detailFromResult(commandResult);
    const missing = detail ? isCommandMissingCause({ message: detail }) : false;
    const discoveredModels =
      commandResult.code === 0
        ? yield* discoverDroidModels(settings, environment, options).pipe(
            Effect.map(Option.some),
            Effect.result,
          )
        : Result.succeed(Option.none<ReadonlyArray<ServerProviderModel>>());
    const modelDiscoveryFailed = commandResult.code === 0 && Result.isFailure(discoveredModels);
    const discoveryMessage = Result.isFailure(discoveredModels)
      ? droidDiscoveryFailureMessage(discoveredModels.failure)
      : undefined;
    const models =
      Result.isSuccess(discoveredModels) && Option.isSome(discoveredModels.success)
        ? modelsWithSettingsFallback(discoveredModels.success.value, settings)
        : fallbackModels;
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: commandResult.code === 0 || !missing,
        version: parseGenericCliVersion(commandResult.stdout || commandResult.stderr),
        status: commandResult.code === 0 && !modelDiscoveryFailed ? "ready" : "warning",
        auth: { status: commandResult.code === 0 ? "unknown" : "unauthenticated" },
        ...(commandResult.code === 0 && discoveryMessage
          ? { message: `Droid model discovery failed: ${discoveryMessage}` }
          : commandResult.code === 0
            ? {}
            : {
                message: missing
                  ? "Droid CLI (`droid`) is not installed or not on PATH."
                  : (detail ?? "Failed to check Droid CLI availability."),
              }),
      },
    });
  });
}

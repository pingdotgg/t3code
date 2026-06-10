import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CopilotSettings,
  ModelCapabilities,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
  ServerSettingsError,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  applyCopilotConfiguredModelMetadata,
  readCopilotMergedSettings,
  type CopilotAuthUser,
} from "../acp/CopilotSettings.ts";
import { CopilotProvider } from "../Services/CopilotProvider.ts";
import {
  buildServerProvider,
  buildSelectOptionDescriptor,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
} from "../providerSnapshot.ts";

const PROVIDER = "copilot" as const;
const DRIVER_KIND = ProviderDriverKind.make(PROVIDER);
const DEFAULT_INSTANCE_ID = ProviderInstanceId.make(PROVIDER);
const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
} as const;
const COPILOT_REFRESH_INTERVAL = "1 hour";
const COPILOT_PROBE_TIMEOUT_MS = 4_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const withDefaultCopilotIdentity = (snapshot: Omit<ServerProvider, "instanceId" | "driver">) => ({
  ...snapshot,
  instanceId: DEFAULT_INSTANCE_ID,
  driver: DRIVER_KIND,
});

const COPILOT_REASONING_LEVELS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true },
  { value: "high", label: "High" },
] as const;

const COPILOT_REASONING_LEVELS_WITH_XHIGH = [
  ...COPILOT_REASONING_LEVELS,
  { value: "xhigh", label: "Extra High" },
] as const;

function supportsCopilotXHigh(slug: string): boolean {
  return /^gpt-5(?:[.-]|$)/u.test(slug);
}

function isCopilotClaudeModel(slug: string): boolean {
  return /^claude(?:[-.]|$)/u.test(slug);
}

function getCopilotModelCapabilities(slug: string): ModelCapabilities {
  // Copilot Claude models do not expose a selectable reasoning effort; the
  // backend only accepts "medium", so offering low/high here would produce an
  // "Invalid value ... for session config option reasoning_effort" turn failure.
  if (isCopilotClaudeModel(slug)) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoning",
        label: "Reasoning",
        options: supportsCopilotXHigh(slug)
          ? COPILOT_REASONING_LEVELS_WITH_XHIGH
          : COPILOT_REASONING_LEVELS,
      }),
    ],
  });
}

function makeCopilotBuiltInModel(slug: string, name: string): ServerProviderModel {
  return {
    slug,
    name,
    isCustom: false,
    capabilities: getCopilotModelCapabilities(slug),
  };
}

const COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  makeCopilotBuiltInModel("auto", "Auto"),
  makeCopilotBuiltInModel("gpt-5.5", "GPT-5.5"),
  makeCopilotBuiltInModel("gpt-5.4", "GPT-5.4"),
  makeCopilotBuiltInModel("gpt-5.4-mini", "GPT-5.4 Mini"),
  makeCopilotBuiltInModel("gpt-5.3-codex", "GPT-5.3 Codex"),
  makeCopilotBuiltInModel("gpt-5.2", "GPT-5.2"),
  makeCopilotBuiltInModel("gpt-5.2-codex", "GPT-5.2 Codex"),
  makeCopilotBuiltInModel("gpt-5.1", "GPT-5.1"),
  makeCopilotBuiltInModel("gpt-5.1-codex", "GPT-5.1 Codex"),
  makeCopilotBuiltInModel("gpt-5.1-codex-max", "GPT-5.1 Codex Max"),
  makeCopilotBuiltInModel("gpt-5.1-codex-mini", "GPT-5.1 Codex Mini"),
  makeCopilotBuiltInModel("gpt-5", "GPT-5"),
  makeCopilotBuiltInModel("gpt-5-mini", "GPT-5 Mini"),
  makeCopilotBuiltInModel("gpt-4.1", "GPT-4.1"),
  makeCopilotBuiltInModel("gpt-4o", "GPT-4o"),
  makeCopilotBuiltInModel("claude-opus-4.8", "Claude Opus 4.8"),
  makeCopilotBuiltInModel("claude-opus-4.7", "Claude Opus 4.7"),
  makeCopilotBuiltInModel("claude-opus-4.6", "Claude Opus 4.6"),
  makeCopilotBuiltInModel("claude-opus-4.5", "Claude Opus 4.5"),
  makeCopilotBuiltInModel("claude-opus-41", "Claude Opus 4.1"),
  makeCopilotBuiltInModel("claude-sonnet-4.6", "Claude Sonnet 4.6"),
  makeCopilotBuiltInModel("claude-sonnet-4.5", "Claude Sonnet 4.5"),
  makeCopilotBuiltInModel("claude-sonnet-4", "Claude Sonnet 4"),
  makeCopilotBuiltInModel("claude-haiku-4.5", "Claude Haiku 4.5"),
  makeCopilotBuiltInModel("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
  makeCopilotBuiltInModel("gemini-3-pro-preview", "Gemini 3 Pro Preview"),
  makeCopilotBuiltInModel("gemini-3-flash-preview", "Gemini 3 Flash Preview"),
  makeCopilotBuiltInModel("gemini-2.5-pro", "Gemini 2.5 Pro"),
  makeCopilotBuiltInModel("grok-code-fast-1", "Grok Code Fast 1"),
];

export function getCopilotFallbackModels(
  copilotSettings: Pick<CopilotSettings, "customModels">,
  configuredModel?: string | null,
): ReadonlyArray<ServerProviderModel> {
  return applyCopilotConfiguredModelMetadata({
    models: providerModelsFromSettings(
      COPILOT_BUILT_IN_MODELS,
      DRIVER_KIND,
      copilotSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    configuredModel,
    currentModel: "auto",
  });
}

function appendProviderMessage(
  message: string | undefined,
  addition: string | undefined,
): string | undefined {
  if (!addition) {
    return message;
  }
  return message ? `${message} ${addition}` : addition;
}

export function buildInitialCopilotProviderSnapshot(
  copilotSettings: CopilotSettings,
): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = getCopilotFallbackModels(copilotSettings);

  if (!copilotSettings.enabled) {
    return withDefaultCopilotIdentity(
      buildServerProvider({
        presentation: COPILOT_PRESENTATION,
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
      }),
    );
  }

  return withDefaultCopilotIdentity(
    buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot provider status has not been checked in this session yet.",
      },
    }),
  );
}

const runCopilotCommand = (settings: CopilotSettings, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(settings.binaryPath, [...args], {
      shell: process.platform === "win32",
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

function missingCopilotProvider(input: {
  readonly settings: CopilotSettings;
  readonly checkedAt: string;
}): ServerProvider {
  return withDefaultCopilotIdentity(
    buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: input.settings.enabled,
      checkedAt: input.checkedAt,
      models: getCopilotFallbackModels(input.settings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "GitHub Copilot CLI was not found. Install it or configure the binary path in T3 Code settings.",
      },
    }),
  );
}

function installedCopilotProvider(input: {
  readonly settings: CopilotSettings;
  readonly checkedAt: string;
  readonly version: string | null;
  readonly configuredModel?: string | null;
  readonly message?: string;
  readonly authUser?: CopilotAuthUser | undefined;
}): ServerProvider {
  const auth: ServerProvider["auth"] = input.authUser
    ? { status: "authenticated", label: input.authUser.login }
    : { status: "unknown" };
  return withDefaultCopilotIdentity(
    buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: input.settings.enabled,
      checkedAt: input.checkedAt,
      models: getCopilotFallbackModels(input.settings, input.configuredModel),
      probe: {
        installed: true,
        version: input.version,
        status: input.message ? "warning" : "ready",
        auth,
        ...(input.message ? { message: input.message } : {}),
      },
    }),
  );
}

export const checkCopilotProviderStatusForSettings = Effect.fn(
  "checkCopilotProviderStatusForSettings",
)(function* (input: {
  readonly settings: CopilotSettings;
  readonly cwd?: string;
}): Effect.fn.Return<ServerProvider, never, ChildProcessSpawner.ChildProcessSpawner> {
  const copilotSettings = input.settings;
  const checkedAt = new Date().toISOString();

  if (!copilotSettings.enabled) {
    return buildInitialCopilotProviderSnapshot(copilotSettings);
  }

  const mergedConfig = yield* readCopilotMergedSettings({
    cwd: input.cwd ?? process.cwd(),
  }).pipe(Effect.provide(NodeServices.layer));
  const configWarning = mergedConfig.warnings[0];
  const configWarningMessage = configWarning
    ? `GitHub Copilot config warning: ${configWarning.message}`
    : undefined;

  const versionProbe = yield* runCopilotCommand(copilotSettings, ["--version"]).pipe(
    Effect.timeoutOption(COPILOT_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isSuccess(versionProbe) && Option.isSome(versionProbe.success)) {
    const result = versionProbe.success.value;
    if (result.code === 0) {
      return installedCopilotProvider({
        settings: copilotSettings,
        checkedAt,
        version: parseGenericCliVersion(result.stdout) ?? parseGenericCliVersion(result.stderr),
        ...(mergedConfig.model ? { configuredModel: mergedConfig.model } : {}),
        ...(configWarningMessage ? { message: configWarningMessage } : {}),
        authUser: mergedConfig.auth,
      });
    }
  }

  if (Result.isFailure(versionProbe) && isCommandMissingCause(versionProbe.failure)) {
    return missingCopilotProvider({ settings: copilotSettings, checkedAt });
  }

  const helpProbe = yield* runCopilotCommand(copilotSettings, ["--help"]).pipe(
    Effect.timeoutOption(COPILOT_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(helpProbe)) {
    const error = helpProbe.failure;
    if (isCommandMissingCause(error)) {
      return missingCopilotProvider({ settings: copilotSettings, checkedAt });
    }
    return withDefaultCopilotIdentity(
      buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models: getCopilotFallbackModels(copilotSettings),
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          ...(() => {
            const message = appendProviderMessage(
              `Failed to execute GitHub Copilot CLI health check: ${
                error instanceof Error ? error.message : String(error)
              }.`,
              configWarningMessage,
            );
            return message ? { message } : {};
          })(),
        },
      }),
    );
  }

  if (Option.isNone(helpProbe.success)) {
    return withDefaultCopilotIdentity(
      buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models: getCopilotFallbackModels(copilotSettings),
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          ...(() => {
            const message = appendProviderMessage(
              "GitHub Copilot CLI is installed but timed out during provider status probing.",
              configWarningMessage,
            );
            return message ? { message } : {};
          })(),
        },
      }),
    );
  }

  const helpResult = helpProbe.success.value;
  if (helpResult.code === 0) {
    return installedCopilotProvider({
      settings: copilotSettings,
      checkedAt,
      version: null,
      ...(mergedConfig.model ? { configuredModel: mergedConfig.model } : {}),
      ...(() => {
        const message = appendProviderMessage(
          "GitHub Copilot CLI version could not be determined.",
          configWarningMessage,
        );
        return message ? { message } : {};
      })(),
      authUser: mergedConfig.auth,
    });
  }

  return withDefaultCopilotIdentity(
    buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: getCopilotFallbackModels(copilotSettings),
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        ...(() => {
          const message = appendProviderMessage(
            "GitHub Copilot CLI is installed, but T3 Code could not verify its version. Runtime startup will validate login and ACP support.",
            configWarningMessage,
          );
          return message ? { message } : {};
        })(),
      },
    }),
  );
});

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(
  function* (input?: {
    readonly cwd?: string;
  }): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.copilot),
    );
    return yield* checkCopilotProviderStatusForSettings({
      settings: copilotSettings,
      ...(input?.cwd !== undefined ? { cwd: input.cwd } : {}),
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
    const refreshForCwd = (cwd: string) =>
      checkCopilotProviderStatus({ cwd }).pipe(
        Effect.provideService(ServerSettingsService, serverSettings),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.tapError(Effect.logError),
        Effect.orDie,
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
    }).pipe(
      Effect.map((provider) =>
        Object.assign(provider, {
          refreshForCwd,
        }),
      ),
    );
  }),
);

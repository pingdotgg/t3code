import type { GeminiSettings, ServerProvider } from "@t3tools/contracts";
import { formatGeminiModelDisplayName } from "@t3tools/shared/gemini";
import { Duration, Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import {
  DEFAULT_GEMINI_MODEL_CAPABILITIES,
  probeGeminiCapabilities,
  type GeminiCapabilityProbeResult,
} from "../geminiAcpProbe.ts";
import { resolveGeminiBinaryPath } from "../geminiBinaryPath.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { GeminiProvider } from "../Services/GeminiProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerSettingsError } from "@t3tools/contracts";

const PROVIDER = "gemini" as const;
const GEMINI_PRESENTATION = {
  displayName: "Gemini",
  showInteractionModeToggle: true,
} as const;

const runGeminiCommand = Effect.fn("runGeminiCommand")(function* (args: ReadonlyArray<string>) {
  const serverSettings = yield* ServerSettingsService;
  const geminiSettings = yield* serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.providers.gemini),
  );
  const binaryPath = resolveGeminiBinaryPath(geminiSettings.binaryPath);
  const command = ChildProcess.make(binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(binaryPath, command);
});

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (
  resolveCapabilities?: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
  }) => Effect.Effect<GeminiCapabilityProbeResult>,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const serverSettings = yield* ServerSettingsService;
  const geminiSettings = yield* serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.providers.gemini),
  );
  const checkedAt = new Date().toISOString();
  const fallbackModels = providerModelsFromSettings(
    [],
    PROVIDER,
    geminiSettings.customModels,
    DEFAULT_GEMINI_MODEL_CAPABILITIES,
    { formatCustomModelName: formatGeminiModelDisplayName },
  );

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  const binaryPath = resolveGeminiBinaryPath(geminiSettings.binaryPath);
  const versionProbe = yield* runGeminiCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Gemini CLI is installed but failed to run. ${detail}`
          : "Gemini CLI is installed but failed to run.",
      },
    });
  }

  const capabilityProbe = yield* (resolveCapabilities ?? probeGeminiCapabilities)({
    binaryPath,
    cwd: process.cwd(),
  });
  const models = providerModelsFromSettings(
    capabilityProbe.models,
    PROVIDER,
    geminiSettings.customModels,
    DEFAULT_GEMINI_MODEL_CAPABILITIES,
    { formatCustomModelName: formatGeminiModelDisplayName },
  );

  return buildServerProvider({
    provider: PROVIDER,
    presentation: GEMINI_PRESENTATION,
    enabled: geminiSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: capabilityProbe.status,
      auth: capabilityProbe.auth,
      ...(capabilityProbe.message ? { message: capabilityProbe.message } : {}),
    },
  });
});

const makePendingGeminiProvider = (geminiSettings: GeminiSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    [],
    PROVIDER,
    geminiSettings.customModels,
    DEFAULT_GEMINI_MODEL_CAPABILITIES,
    { formatCustomModelName: formatGeminiModelDisplayName },
  );

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    presentation: GEMINI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Gemini provider status has not been checked in this session yet.",
    },
  });
};

export const GeminiProviderLive = Layer.effect(
  GeminiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkGeminiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<GeminiSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.gemini),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.gemini),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingGeminiProvider,
      checkProvider,
      refreshInterval: Duration.minutes(2),
    });
  }),
);

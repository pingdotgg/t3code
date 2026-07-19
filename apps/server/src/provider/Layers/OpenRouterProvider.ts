import type { OpenRouterSettings, ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  probeCliVersion,
  providerModelsFromSettings,
  type CliVersionProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  FALLBACK_OPENROUTER_MODELS,
  EMPTY_OPENROUTER_CAPABILITIES,
  fetchOpenRouterModels,
  type OpenRouterModelFetchResult,
} from "../openrouter/OpenRouterModels.ts";
import {
  OPENROUTER_DRIVER_KIND,
  normalizeOpenRouterBaseUrl,
} from "../openrouter/OpenRouterRuntime.ts";

const OPENROUTER_PRESENTATION = {
  displayName: "OpenRouter",
  showInteractionModeToggle: true,
} as const;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function modelsFromSettings(
  builtIn: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtIn,
    OPENROUTER_DRIVER_KIND,
    customModels,
    EMPTY_OPENROUTER_CAPABILITIES,
  );
}

function cliProbeFields(cli: CliVersionProbeResult): {
  readonly installed: boolean;
  readonly version: string | null;
  readonly cliOk: boolean;
  readonly cliMessage: string;
} {
  switch (cli.kind) {
    case "missing":
      return {
        installed: false,
        version: null,
        cliOk: false,
        cliMessage:
          "Claude Agent CLI (`claude`) is not installed or not on PATH. OpenRouter uses Claude Code as its agent runtime.",
      };
    case "error":
      return {
        installed: true,
        version: null,
        cliOk: false,
        cliMessage: "Failed to execute Claude Agent CLI health check for OpenRouter.",
      };
    case "timeout":
      return {
        installed: true,
        version: null,
        cliOk: false,
        cliMessage: "Claude Agent CLI timed out while running `--version` for OpenRouter.",
      };
    case "failed":
      return {
        installed: true,
        version: cli.version,
        cliOk: false,
        cliMessage: "Claude Agent CLI is installed but failed to run for OpenRouter.",
      };
    case "ok":
      return {
        installed: true,
        version: cli.version,
        cliOk: true,
        cliMessage: "",
      };
    default: {
      const _exhaustive: never = cli;
      return _exhaustive;
    }
  }
}

function mergeOpenRouterProbe(input: {
  readonly settings: OpenRouterSettings;
  readonly checkedAt: string;
  readonly fallbackModels: ReadonlyArray<ServerProviderModel>;
  readonly cli: CliVersionProbeResult;
  readonly modelFetch: OpenRouterModelFetchResult;
}): ServerProviderDraft {
  const { settings, checkedAt, fallbackModels, cli, modelFetch } = input;
  const cliFields = cliProbeFields(cli);
  const authOk = modelFetch.ok;
  const auth = authOk
    ? {
        status: "authenticated" as const,
        type: "api_key" as const,
        label: "OpenRouter API key",
      }
    : {
        status: modelFetch.authFailed ? ("unauthenticated" as const) : ("unknown" as const),
        ...(modelFetch.authFailed ? { label: "OpenRouter API key" as const } : {}),
      };

  const models = authOk
    ? modelsFromSettings(modelFetch.models, settings.customModels)
    : fallbackModels;

  if (cliFields.cliOk && authOk) {
    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: cliFields.version,
        status: "ready",
        auth,
        message: `Using ${normalizeOpenRouterBaseUrl(settings.baseUrl)} via Claude Code runtime.`,
      },
    });
  }

  const messages: string[] = [];
  if (!cliFields.cliOk) {
    messages.push(cliFields.cliMessage);
  }
  if (!authOk) {
    messages.push(modelFetch.message);
  }

  const status =
    !cliFields.cliOk || (modelFetch.ok === false && modelFetch.authFailed) ? "error" : "warning";

  return buildServerProvider({
    presentation: OPENROUTER_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe: {
      installed: cliFields.installed,
      version: cliFields.version,
      status,
      auth,
      message: messages.join(" "),
    },
  });
}

export const makePendingOpenRouterProvider = (
  settings: OpenRouterSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = modelsFromSettings(FALLBACK_OPENROUTER_MODELS, settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: OPENROUTER_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenRouter is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenRouter provider status has not been checked in this session yet.",
      },
    });
  });

export const checkOpenRouterProviderStatus = Effect.fn("checkOpenRouterProviderStatus")(function* (
  settings: OpenRouterSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = yield* nowIso;
  const fallbackModels = modelsFromSettings(FALLBACK_OPENROUTER_MODELS, settings.customModels);

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenRouter is disabled in T3 Code settings.",
      },
    });
  }

  // CLI health and OpenRouter auth are independent — probe in parallel and merge.
  const [cli, modelFetch] = yield* Effect.all(
    [probeCliVersion(settings.binaryPath, resolvedEnvironment), fetchOpenRouterModels(settings)],
    { concurrency: 2 },
  );

  return mergeOpenRouterProbe({
    settings,
    checkedAt,
    fallbackModels,
    cli,
    modelFetch,
  });
});

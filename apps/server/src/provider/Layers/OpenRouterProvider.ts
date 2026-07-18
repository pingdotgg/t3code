import {
  type ModelCapabilities,
  type OpenRouterSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_DRIVER_KIND,
  normalizeOpenRouterBaseUrl,
  openRouterModelsUrl,
} from "../openrouter/OpenRouterRuntime.ts";

const OPENROUTER_PRESENTATION = {
  displayName: "OpenRouter",
  showInteractionModeToggle: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_OPENROUTER_MODEL,
    name: "Claude Sonnet 4",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "openai/gpt-4o",
    name: "GPT-4o",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const OpenRouterModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
    }),
  ),
});

const decodeOpenRouterModelsResponse = Schema.decodeUnknownEffect(OpenRouterModelsResponse);
const MAX_DISCOVERED_MODELS = 200;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function modelsFromSettings(
  builtIn: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtIn,
    OPENROUTER_DRIVER_KIND,
    customModels,
    EMPTY_CAPABILITIES,
  );
}

const runClaudeVersionProbe = Effect.fn("runOpenRouterClaudeVersionProbe")(function* (
  settings: OpenRouterSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
    env: environment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: environment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(settings.binaryPath, command);
});

type OpenRouterModelFetchResult =
  | {
      readonly ok: true;
      readonly models: ReadonlyArray<ServerProviderModel>;
    }
  | {
      readonly ok: false;
      readonly authFailed: boolean;
      readonly message: string;
    };

const fetchOpenRouterModels = Effect.fn("fetchOpenRouterModels")(function* (
  settings: OpenRouterSettings,
): Effect.fn.Return<OpenRouterModelFetchResult, never, HttpClient.HttpClient> {
  const apiKey = settings.apiKey.trim();
  if (apiKey.length === 0) {
    return {
      ok: false,
      authFailed: true,
      message: "Add an OpenRouter API key in provider settings.",
    };
  }

  const httpClient = yield* HttpClient.HttpClient;
  const url = openRouterModelsUrl(settings.baseUrl);
  const response = yield* HttpClientRequest.get(url).pipe(
    HttpClientRequest.bearerToken(apiKey),
    HttpClientRequest.acceptJson,
    httpClient.execute,
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(response)) {
    return {
      ok: false,
      authFailed: false,
      message: "Failed to reach OpenRouter models API.",
    };
  }

  if (Option.isNone(response.success)) {
    return {
      ok: false,
      authFailed: false,
      message: "Timed out while fetching OpenRouter models.",
    };
  }

  const httpResponse = response.success.value;
  if (httpResponse.status === 401 || httpResponse.status === 403) {
    return {
      ok: false,
      authFailed: true,
      message: "OpenRouter API key is missing or invalid.",
    };
  }

  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return {
      ok: false,
      authFailed: false,
      message: `OpenRouter models API returned HTTP ${httpResponse.status}.`,
    };
  }

  const body = yield* httpResponse.json.pipe(Effect.result);
  if (Result.isFailure(body)) {
    return {
      ok: false,
      authFailed: false,
      message: "OpenRouter models API returned an unreadable response.",
    };
  }

  const decoded = yield* decodeOpenRouterModelsResponse(body.success).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    return {
      ok: false,
      authFailed: false,
      message: "OpenRouter models API returned an unexpected payload.",
    };
  }

  const models = decoded.success.data
    .filter((model) => model.id.trim().length > 0)
    .slice(0, MAX_DISCOVERED_MODELS)
    .map(
      (model): ServerProviderModel => ({
        slug: model.id,
        name: model.name?.trim() || model.id,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      }),
    );

  if (models.length === 0) {
    return {
      ok: false,
      authFailed: false,
      message: "OpenRouter returned an empty model catalog.",
    };
  }

  return { ok: true, models };
});

export const makePendingOpenRouterProvider = (
  settings: OpenRouterSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = modelsFromSettings(FALLBACK_MODELS, settings.customModels);

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
  ChildProcessSpawner.ChildProcessSpawner | Path.Path | HttpClient.HttpClient
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = yield* nowIso;
  const fallbackModels = modelsFromSettings(FALLBACK_MODELS, settings.customModels);

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

  const versionProbe = yield* runClaudeVersionProbe(settings, resolvedEnvironment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: {
          status: settings.apiKey.trim().length > 0 ? "unknown" : "unauthenticated",
        },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH. OpenRouter uses Claude Code as its agent runtime."
          : "Failed to execute Claude Agent CLI health check for OpenRouter.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI timed out while running `--version` for OpenRouter.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run for OpenRouter.",
      },
    });
  }

  const modelFetch = yield* fetchOpenRouterModels(settings);
  if (!modelFetch.ok) {
    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: modelFetch.authFailed ? "error" : "warning",
        auth: {
          status: modelFetch.authFailed ? "unauthenticated" : "unknown",
          ...(modelFetch.authFailed ? { label: "OpenRouter API key" } : {}),
        },
        message: modelFetch.message,
      },
    });
  }

  return buildServerProvider({
    presentation: OPENROUTER_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: modelsFromSettings(modelFetch.models, settings.customModels),
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        type: "api_key",
        label: "OpenRouter API key",
      },
      message: `Using ${normalizeOpenRouterBaseUrl(settings.baseUrl)} via Claude Code runtime.`,
    },
  });
});

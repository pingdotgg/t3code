import type { OllamaSettings, ServerProviderConnection } from "@t3tools/contracts";
import { Effect, Equal, Layer, Stream } from "effect";

import { buildServerProvider } from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { OllamaProvider } from "../Services/OllamaProvider";
import { ServerSettingsService } from "../../serverSettings";
import {
  combineOllamaProviderState,
  probeOllamaConnection,
  resolveOllamaConnections,
} from "../ollama/client";

const PROVIDER = "ollama" as const;

function connectionErrorSnapshot(input: {
  readonly connection: ReturnType<typeof resolveOllamaConnections>[number];
  readonly checkedAt: string;
  readonly message: string;
}): ServerProviderConnection {
  return {
    id: input.connection.connection.id,
    name: input.connection.connection.name,
    baseUrl: input.connection.connection.baseUrl,
    isDefault: input.connection.connection.isDefault,
    enabled: true,
    version: null,
    status: "error",
    auth: input.connection.auth,
    checkedAt: input.checkedAt,
    message: input.message,
    models: input.connection.connection.customModels.map((model) => ({
      slug: model,
      name: model,
      isCustom: true,
      capabilities: null,
    })),
  };
}

export const checkOllamaProviderStatus = Effect.fn("checkOllamaProviderStatus")(function* () {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings;
  const ollamaSettings = settings.providers.ollama;
  const checkedAt = new Date().toISOString();
  const resolvedConnections = resolveOllamaConnections(settings);

  if (!ollamaSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: [],
      connections: [],
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Ollama is disabled in T3 Code settings.",
      },
    });
  }

  const probedConnections = yield* Effect.forEach(
    resolvedConnections,
    (connection) =>
      probeOllamaConnection({ connection }).pipe(
        Effect.map((result) => result.connection),
        Effect.catch((error) =>
          Effect.succeed(
            connectionErrorSnapshot({
              connection,
              checkedAt,
              message: error instanceof Error ? error.message : "Failed to reach Ollama host.",
            }),
          ),
        ),
      ),
    { concurrency: "unbounded" },
  );

  const aggregate = combineOllamaProviderState(probedConnections);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: ollamaSettings.enabled,
    checkedAt,
    models: aggregate.models,
    connections: probedConnections,
    probe: {
      installed: aggregate.installed,
      version: aggregate.version,
      status: aggregate.status,
      auth: aggregate.auth,
      ...(aggregate.message ? { message: aggregate.message } : {}),
    },
  });
});

const makeOllamaProvider = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const checkProvider = checkOllamaProviderStatus().pipe(
    Effect.provideService(ServerSettingsService, settingsService),
  );

  return yield* makeManagedServerProvider<OllamaSettings>({
    getSettings: settingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.ollama),
      Effect.orDie,
    ),
    streamSettings: settingsService.streamChanges.pipe(
      Stream.map((settings) => settings.providers.ollama),
    ),
    haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
    checkProvider,
  });
});

export const OllamaProviderLive = Layer.effect(OllamaProvider, makeOllamaProvider);

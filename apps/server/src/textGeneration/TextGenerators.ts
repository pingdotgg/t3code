import {
  type ListTextGeneratorModelsInput,
  type ListTextGeneratorModelsResult,
  type ProviderInstanceId,
  TextGenerationError,
  type TextGeneratorConfig,
  TextGeneratorError,
  type TextGeneratorModel,
  textGeneratorForSelection,
} from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  TEXT_GENERATOR_DRIVERS,
  type TextGeneratorConnection,
  TextGeneratorRequestError,
} from "./textGeneratorDrivers.ts";

/** Text generators configured in settings: model APIs that generate text but cannot run agents. */
export class TextGenerators extends Context.Service<
  TextGenerators,
  {
    /** The runner for a text generator id, or undefined when the id names no text generator. */
    readonly runner: (
      id: ProviderInstanceId,
    ) => Effect.Effect<TextGenerationOperations.Runner | undefined>;
    readonly listModels: (
      input: ListTextGeneratorModelsInput,
    ) => Effect.Effect<ListTextGeneratorModelsResult, TextGeneratorError>;
  }
>()("t3/textGeneration/TextGenerators") {}

interface CachedModels {
  readonly config: TextGeneratorConfig;
  readonly models: ReadonlyArray<TextGeneratorModel>;
}

/** @public */
export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const http = yield* HttpClient.HttpClient;
  const modelCache = yield* Ref.make(new Map<ProviderInstanceId, CachedModels>());

  const readConfig = Effect.fn("TextGenerators.readConfig")(function* (id: ProviderInstanceId) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new TextGeneratorRequestError({ detail: "Could not read settings." })),
    );
    return textGeneratorForSelection(settings, id);
  });

  const connect = Effect.fn("TextGenerators.connect")(function* (config: TextGeneratorConfig) {
    const apiKey = yield* requireSettingsSecret(secrets, config.apiKey).pipe(
      Effect.mapError((cause) => new TextGeneratorRequestError({ detail: cause.message, cause })),
    );
    return { baseUrl: config.baseUrl, apiKey } satisfies TextGeneratorConnection;
  });

  const runnerFor =
    (config: TextGeneratorConfig): TextGenerationOperations.Runner =>
    (request) => {
      const driver = TEXT_GENERATOR_DRIVERS[config.kind];
      const label = config.label ?? driver.label;
      return connect(config).pipe(
        Effect.flatMap((connection) =>
          driver.generate(connection, request.modelSelection.model, request.prompt),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError(
          (error) =>
            new TextGenerationError({
              operation: request.operation,
              detail: error.detail,
              cause: error,
            }),
        ),
        Effect.flatMap((text) => TextGenerationOperations.decodeJsonReply(request, label, text)),
      );
    };

  const runner = Effect.fn("TextGenerators.runner")(function* (id: ProviderInstanceId) {
    const config = yield* readConfig(id).pipe(Effect.orElseSucceed(() => undefined));
    if (config === undefined) return undefined;
    const label = config.label ?? TEXT_GENERATOR_DRIVERS[config.kind].label;
    if (!config.enabled) {
      return ((request) =>
        Effect.fail(
          new TextGenerationError({
            operation: request.operation,
            detail: `${label} is turned off in Settings.`,
          }),
        )) satisfies TextGenerationOperations.Runner;
    }
    return TextGenerationOperations.withoutInvestigation(label, runnerFor(config));
  });

  const listModels = Effect.fn("TextGenerators.listModels")(
    function* (input: ListTextGeneratorModelsInput) {
      const config = yield* readConfig(input.id);
      if (config === undefined) {
        return yield* new TextGeneratorRequestError({ detail: "No such text generator." });
      }
      const cached = (yield* Ref.get(modelCache)).get(input.id);
      // Keyed on the whole config so a changed URL or key never serves another API's list.
      if (input.refresh !== true && cached !== undefined && Equal.equals(cached.config, config)) {
        return { models: cached.models };
      }
      const connection = yield* connect(config);
      const models = yield* TEXT_GENERATOR_DRIVERS[config.kind]
        .listModels(connection)
        .pipe(Effect.provideService(HttpClient.HttpClient, http));
      yield* Ref.update(modelCache, (current) =>
        new Map(current).set(input.id, { config, models }),
      );
      return { models };
    },
    Effect.mapError((error) => new TextGeneratorError({ detail: error.detail })),
  );

  return TextGenerators.of({ runner, listModels });
});

export const layer = Layer.effect(TextGenerators, make).pipe(
  Layer.provide([SecretResolverLayer.layer, FetchHttpClient.layer]),
);

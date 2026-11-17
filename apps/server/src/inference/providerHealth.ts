import {
  isInferenceProviderConfig,
  ProviderInstanceId,
  type ServerProvider,
  type InferenceProviderConfig,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import { InferenceProxy } from "./InferenceProxy.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerSettings from "../serverSettings.ts";

export const makeInferenceProviderHealth = Effect.fn("makeInferenceProviderHealth")(function* () {
  const proxy = yield* InferenceProxy;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const catalogs = yield* Cache.make({
    capacity: 32,
    timeToLive: "15 seconds",
    lookup: Effect.fn("InferenceProviderHealth.probe")(
      function* (input: {
        readonly route: InferenceProviderConfig;
        readonly key: string;
        readonly driver: string;
      }) {
        return yield* proxy
          .routeHealth(input.route, input.key, input.driver)
          .pipe(Effect.map((health) => ({ health })));
      },
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ({ problem: "Inference host is unreachable or unavailable." })),
    ),
  });

  const apply = Effect.fn("InferenceProviderHealth.apply")(
    function* (provider: ServerProvider) {
      if (!provider.enabled || provider.availability === "unavailable") return provider;
      const current = yield* settings.getSettings;
      const route = current.providerInstances[provider.instanceId]?.config;
      if (!isInferenceProviderConfig(route) || !route.inferenceEnabled) return provider;
      const key =
        typeof route.inferenceKey === "string"
          ? route.inferenceKey
          : (yield* secrets.read([route.inferenceKey]))[0];
      const catalog = key
        ? yield* Cache.get(catalogs, { route, key, driver: provider.driver })
        : { problem: "Inference host credential is unavailable." };
      const problem =
        "problem" in catalog
          ? catalog.problem
          : catalog.health.availableDrivers.some((driver) => driver === provider.driver) &&
              route.inferenceModels.some((model) => catalog.health.models.includes(model))
            ? undefined
            : "Inference host has no available models for this provider.";
      return problem === undefined
        ? {
            ...provider,
            models: provider.models.filter(
              (model) => "health" in catalog && catalog.health.models.includes(model.slug),
            ),
          }
        : {
            ...provider,
            availability: "unavailable" as const,
            unavailableReason: problem,
            status: "error" as const,
            message: problem,
          };
    },
    (effect, provider) =>
      effect.pipe(
        Effect.orElseSucceed(() => ({
          ...provider,
          availability: "unavailable" as const,
          unavailableReason: "Could not check provider availability.",
        })),
      ),
  );

  return {
    apply,
    instanceIds: settings.getSettings.pipe(
      Effect.map(({ providerInstances }) =>
        Object.entries(providerInstances).flatMap(([id, instance]) =>
          isInferenceProviderConfig(instance.config) && instance.config.inferenceEnabled
            ? [ProviderInstanceId.make(id)]
            : [],
        ),
      ),
      Effect.orElseSucceed(() => []),
    ),
    invalidate: Cache.invalidateAll(catalogs),
  };
});

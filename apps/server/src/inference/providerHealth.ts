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

export function filterInferenceWorkspaceModels(
  provider: ServerProvider,
  snapshots: NonNullable<ServerProvider["workspaceSnapshots"]>,
): NonNullable<ServerProvider["workspaceSnapshots"]> {
  if (provider.driver !== "pi" && provider.driver !== "opencode") return snapshots;
  const routedModels = new Set(
    provider.models.filter((model) => model.slug.startsWith("t3proxy/")).map((model) => model.slug),
  );
  const filtered = snapshots.map((snapshot) => {
    if (snapshot.models === undefined) return snapshot;
    const models = snapshot.models.filter(
      (model) => !model.slug.startsWith("t3proxy/") || routedModels.has(model.slug),
    );
    return models.length === snapshot.models.length ? snapshot : { ...snapshot, models };
  });
  return filtered.every((snapshot, index) => snapshot === snapshots[index]) ? snapshots : filtered;
}

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
      const mixedCatalog = provider.driver === "pi" || provider.driver === "opencode";
      const servedModels =
        "health" in catalog &&
        catalog.health.availableDrivers.some((driver) => driver === provider.driver)
          ? new Set(catalog.health.models)
          : new Set<string>();
      const models = provider.models.filter((model) => {
        if (!mixedCatalog) return servedModels.has(model.slug);
        if (!model.slug.startsWith("t3proxy/")) return true;
        const id = model.slug.slice("t3proxy/".length);
        return route.inferenceModels.includes(id) && servedModels.has(id);
      });
      const problem =
        "problem" in catalog
          ? catalog.problem
          : route.inferenceModels.some((model) => servedModels.has(model))
            ? undefined
            : "Inference host has no available models for this provider.";
      if (mixedCatalog) {
        const availableProvider = {
          ...provider,
          models,
          ...(provider.workspaceSnapshots === undefined
            ? {}
            : {
                workspaceSnapshots: filterInferenceWorkspaceModels(
                  { ...provider, models },
                  provider.workspaceSnapshots,
                ),
              }),
        };
        return models.length > 0 || problem === undefined
          ? availableProvider
          : {
              ...availableProvider,
              status: provider.status === "ready" ? ("warning" as const) : provider.status,
              message: problem,
            };
      }
      return problem === undefined
        ? { ...provider, models }
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

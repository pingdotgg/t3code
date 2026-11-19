import {
  isInferenceProviderConfig,
  ProviderInstanceId,
  TRAEX_BRIDGE_INSTANCE_ID,
  type ServerProvider,
  type InferenceProviderConfig,
} from "@t3tools/contracts";
import { isProviderInstanceEnabledInAnyScope } from "@t3tools/shared/serverSettings";
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
  const routedModels = new Map(provider.models.map((model) => [model.slug, model]));
  const filtered = snapshots.map((snapshot) => {
    if (snapshot.models === undefined) return snapshot;
    const models = snapshot.models.flatMap((model) => {
      if (!model.slug.startsWith("t3proxy/")) return [model];
      const routed = routedModels.get(model.slug);
      if (!routed) return [];
      if (routed.isUnavailable === model.isUnavailable) return [model];
      if (routed.isUnavailable) return [{ ...model, isUnavailable: true }];
      const { isUnavailable: _unavailable, ...available } = model;
      return [available];
    });
    return models.length === snapshot.models.length &&
      models.every((model, i) => model === snapshot.models?.[i])
      ? snapshot
      : { ...snapshot, models };
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
      const unavailable = new Set("health" in catalog ? catalog.health.unavailableModels : []);
      const models = provider.models.flatMap((model) => {
        if (mixedCatalog && !model.slug.startsWith("t3proxy/")) return [model];
        const id = mixedCatalog ? model.slug.slice("t3proxy/".length) : model.slug;
        if (mixedCatalog && !route.inferenceModels.includes(id)) return [];
        if (servedModels.has(id)) return [model];
        return unavailable.has(id) ? [{ ...model, isUnavailable: true }] : [];
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
      if (problem === undefined) return { ...provider, models };
      return {
        ...provider,
        models: models.length ? models : provider.models,
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

  const instanceIds = settings.getSettings.pipe(
    Effect.map((settings) =>
      Object.entries(settings.providerInstances).flatMap(([id, instance]) => {
        const instanceId = ProviderInstanceId.make(id);
        return isProviderInstanceEnabledInAnyScope(settings, instanceId) &&
          isInferenceProviderConfig(instance.config) &&
          instance.config.inferenceEnabled
          ? [instanceId]
          : [];
      }),
    ),
    Effect.orElseSucceed((): ProviderInstanceId[] => []),
  );
  const refreshModelCatalog = Effect.fn("InferenceProviderHealth.refreshModelCatalog")(function* (
    fresh?: boolean,
    instanceId?: ProviderInstanceId,
  ) {
    if (
      instanceId === undefined ||
      instanceId === TRAEX_BRIDGE_INSTANCE_ID ||
      (yield* instanceIds).includes(instanceId)
    )
      yield* proxy.refreshModelCatalog(fresh, instanceId);
  });
  return {
    apply,
    instanceIds,
    refreshModelCatalog,
    invalidate: Cache.invalidateAll(catalogs),
  };
});

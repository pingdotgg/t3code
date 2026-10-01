import {
  ProviderRegistry,
  type ProviderRegistryShape,
  type ProviderRegistrySnapshot,
} from "../Services/ProviderRegistry.ts";
import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistryShape => ({
  getProviders: Effect.succeed(providers),
  getProvidersSnapshot: Effect.succeed({ revision: 0, providers }),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  refreshWorkspaceSnapshot: () => Effect.succeed(providers),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
  // Tests never drive changes through this mock; acquire a throwaway
  // subscription on an unused PubSub so the shape is satisfied.
  subscribeChanges: Effect.flatMap(PubSub.unbounded<ProviderRegistrySnapshot>(), (pubsub) =>
    PubSub.subscribe(pubsub),
  ),
});

export const makeProviderRegistryLayer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry, makeProviderRegistryMock(providers));

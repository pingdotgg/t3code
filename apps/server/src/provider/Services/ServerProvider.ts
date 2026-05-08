import type { ServerProvider } from "@t3tools/contracts";
import type { Effect, PubSub, Scope, Stream } from "effect";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<ServerProvider>, never, Scope.Scope>;
}

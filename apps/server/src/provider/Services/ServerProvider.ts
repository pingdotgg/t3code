import type { ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ProviderSnapshotRefreshInput {
  readonly cwd?: string | undefined;
}

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: (input?: ProviderSnapshotRefreshInput) => Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}

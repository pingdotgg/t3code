import type { ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /**
   * Identifies the driver's unprobed startup snapshot. Registries use this to
   * keep a hydrated disk snapshot only until the first live probe completes.
   *
   * Optional for compatibility with static/test snapshot sources. A source
   * that does not expose lifecycle state is treated as live rather than
   * allowing a stale cache entry to mask it.
   */
  readonly isInitialSnapshot?: (snapshot: ServerProvider) => boolean;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}

import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { RawUsageWindowInput } from "../providerUsageLimits.ts";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Fold live rate-limit telemetry into the published snapshot without waiting
   * for the next status probe. Sparse by contract — windows the update omits
   * keep their previous values, and an update with no usable window leaves the
   * snapshot untouched.
   */
  readonly applyUsageLimits: (update: {
    readonly source: ServerProviderUsageLimits["source"];
    readonly checkedAt: string;
    readonly windows: ReadonlyArray<RawUsageWindowInput>;
  }) => Effect.Effect<void>;
}

import type {
  ProviderUsageLimitsUpdate,
  ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "./maintenance.ts";

export interface ManagedServerProvider {
  /** Cached; pass { fresh: true } before executing updates. */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly refreshUsage?: Effect.Effect<void, ServerSettingsError>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Fold a runtime rate-limit update into the published snapshot without
   * waiting for the next status probe. Sparse: windows merge by id and an
   * update with no usable window leaves the snapshot untouched. With
   * `replace`, the update's windows are the whole set instead.
   */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & {
      readonly checkedAt: string;
      readonly replace?: boolean;
    },
  ) => Effect.Effect<void>;
}

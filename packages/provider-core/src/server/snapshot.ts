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
   * Merge windows by ID; updates with no usable window leave the snapshot untouched.
   * `replaceWindows` publishes a complete window set instead, clearing omitted windows.
   */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & {
      readonly checkedAt: string;
      readonly replaceWindows?: boolean;
    },
  ) => Effect.Effect<void>;
}

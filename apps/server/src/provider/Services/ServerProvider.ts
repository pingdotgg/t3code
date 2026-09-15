import type { ProviderUsageLimitsUpdate, ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  /**
   * Ownership-derived update capabilities. Cached between reads; pass
   * `{ fresh: true }` before executing an update so it never trusts a
   * resolution older than the click.
   */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /**
   * Settles once the first status probe has completed, whichever way it
   * went. Until then `getSnapshot` is the boot placeholder, which carries no
   * slash commands and must not be captured as a per-workspace snapshot.
   */
  readonly awaitFirstProbe: Effect.Effect<void>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Fold a runtime rate-limit update into the published snapshot without
   * waiting for the next status probe. Sparse: windows merge by id and an
   * update with no usable window leaves the snapshot untouched.
   */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
}

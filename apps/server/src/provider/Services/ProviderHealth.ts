/**
 * ProviderHealth - Provider readiness snapshot service.
 *
 * Owns startup-time provider health checks (install/auth reachability) and
 * exposes the cached results to transport layers.
 *
 * @module ProviderHealth
 */
import type { ServerProviderStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ProviderHealthShape {
  /**
   * Read provider health statuses (from the latest check).
   */
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Re-run provider health checks with an optional custom binary path.
   * Returns the updated statuses.
   */
  readonly recheckStatuses: (
    binaryPath?: string,
  ) => Effect.Effect<ReadonlyArray<ServerProviderStatus>>;
}

export class ProviderHealth extends ServiceMap.Service<ProviderHealth, ProviderHealthShape>()(
  "t3/provider/Services/ProviderHealth",
) {}

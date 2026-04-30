/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * @module ProviderRegistry
 */
import type { ProviderInstanceId, ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots for every configured instance.
   * Multiple snapshots may share the same `provider` kind (multiple
   * instances of the same driver) and disambiguate via `instanceId`.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh all providers, or the default instance of the specified
   * kind when supplied.
   *
   * Retained for back-compat with legacy call sites (WS refresh RPC,
   * orchestration metrics). New code should prefer `refreshInstance`.
   *
   * @deprecated prefer `refreshInstance` for new call sites.
   */
  readonly refresh: (provider?: ProviderDriverKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh the specific configured instance. Returns the updated snapshot
   * list. When the instance id is unknown the call resolves with the
   * currently cached list (no error) — matching the legacy `refresh` shim
   * behaviour so transport layers don't have to special-case unknowns.
   */
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Stream of provider snapshot updates — one emission per aggregated
   * change. The array contains the full current state.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "t3/provider/Services/ProviderRegistry",
) {}

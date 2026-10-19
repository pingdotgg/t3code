/**
 * Closes the per-instance `Scope` of every removed or replaced entry (tearing
 * down adapter processes, refresh fibres, temp files) BEFORE creating the
 * replacement — `reconcile` guarantees "at most one live instance per id" at
 * all times.
 */
import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  readonly reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/ProviderInstanceRegistryMutator") {}

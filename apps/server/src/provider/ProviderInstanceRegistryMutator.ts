/** Reconcile closes removed/replaced scopes before creating replacements: at most one live instance per id. */
import type { ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderProxyRoute } from "@t3tools/provider-core/server/providerProxy";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Runtime-only inputs ride on the entry, so a change to them rebuilds the instance. */
export type ProviderInstanceRuntimeEntry = ProviderInstanceConfig & {
  readonly proxy?: ProviderProxyRoute;
};
export type ProviderInstanceRuntimeMap = Readonly<Record<string, ProviderInstanceRuntimeEntry>>;

export interface ProviderInstanceRegistryMutatorShape {
  readonly reconcile: (configMap: ProviderInstanceRuntimeMap) => Effect.Effect<void>;
  /** Re-reads the secrets of every instance, or one, and rebuilds those whose secrets changed. */
  readonly reloadSecrets: (instanceId?: ProviderInstanceId) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/ProviderInstanceRegistryMutator") {}

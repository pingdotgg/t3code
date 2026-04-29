/**
 * ProviderInstanceRegistryMutator — internal handle used by the hydration
 * layer to reconcile the live registry with a fresh
 * `ProviderInstanceConfigMap`.
 *
 * Kept separate from the public `ProviderInstanceRegistry` service tag so
 * downstream consumers (drivers, reactors, `ProviderService`) can only read
 * from the registry. Only the hydration layer — which watches
 * `ServerSettingsService.streamChanges` and applies diffs — imports this
 * tag.
 *
 * The mutator exposes a single entry point, `reconcile(configMap)`, which:
 *
 *   1. Diffs the incoming map against the live one keyed by instance id.
 *   2. Closes the per-instance `Scope` of every removed or replaced entry
 *      (tearing down adapter processes, refresh fibres, temp files) BEFORE
 *      creating the replacement — `reconcile` guarantees "at most one live
 *      instance per id" at all times.
 *   3. Opens a fresh child `Scope` for every added or replaced entry, runs
 *      the driver's `create`, and stores the resulting `ProviderInstance`
 *      plus its scope.
 *   4. Publishes one `void` tick on the registry's `streamChanges` PubSub at
 *      the end of the batch — consumers re-pull `listInstances` /
 *      `listUnavailable`.
 *
 * `reconcile` is idempotent: calling it with an unchanged config map is a
 * no-op (no scope churn, no pubsub emission).
 *
 * @module provider/Services/ProviderInstanceRegistryMutator
 */
import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProviderInstanceRegistryMutatorShape {
  /**
   * Bring the live registry in line with the supplied config map. See
   * module docs for the add / remove / replace semantics.
   *
   * The effect never fails: individual driver `create` failures are
   * captured as "unavailable" shadow snapshots inside the registry, the
   * same way boot-time failures are handled by
   * `makeProviderInstanceRegistry`. This keeps settings-watcher loops from
   * erroring out on a single bad entry.
   */
  readonly reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/Services/ProviderInstanceRegistryMutator") {}

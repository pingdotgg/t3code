/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * @module ProviderRegistry
 */
import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export type ProviderMaintenanceActionKind = "update";

/**
 * A provider list stamped with the registry's monotonic revision. The
 * revision is bumped inside the same atomic `Ref` swap that installs the
 * provider list, so it is shared by snapshots and change publications:
 * a publication carrying `revision <= snapshot.revision` predates that
 * snapshot and must not replay over it.
 */
export interface ProviderRegistrySnapshot {
  readonly revision: number;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots for every configured instance.
   * Multiple snapshots may share the same `provider` kind (multiple
   * instances of the same driver) and disambiguate via `instanceId`.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Read the latest provider snapshots together with the registry's
   * current revision. Paired with `subscribeChanges` this is the fence
   * for snapshot-then-changes feeds: queued publications with
   * `revision <= snapshot.revision` are already folded into the snapshot
   * and replaying them would deliver stale state after newer state.
   */
  readonly getProvidersSnapshot: Effect.Effect<ProviderRegistrySnapshot>;

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

  readonly refreshWorkspaceSnapshot: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Resolve the maintenance capabilities owned by one live provider instance.
   * Falls back to manual-only capabilities when the instance is not live.
   * `fresh` re-derives ownership from the executable instead of the cache.
   */
  readonly getProviderMaintenanceCapabilitiesForInstance: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
    options?: { readonly fresh?: boolean },
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;

  /**
   * Apply volatile maintenance-action state to one configured instance.
   * This state is never persisted to disk. Today only update actions are
   * projected onto `ServerProvider.updateState`; install/auth actions can
   * extend this action map without adding driver-scoped APIs.
   */
  readonly setProviderMaintenanceActionState: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly action: ProviderMaintenanceActionKind;
    readonly state: ServerProviderUpdateState | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Stream of provider snapshot updates — one emission per aggregated
   * change. The array contains the full current state.
   *
   * NOTE: `Stream.fromPubSub` defers `PubSub.subscribe` until the stream
   * starts running, so a consumer that reads `getProviders` before running
   * the stream can miss a publish that lands in between. Snapshot-then-
   * changes feeds must use `subscribeChanges` + `getProvidersSnapshot`
   * instead — see their docs.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;

  /**
   * Acquire a subscription to the change channel synchronously in the
   * caller's fiber, scoped to the provided `Scope` (released on scope
   * close). Because the subscription is registered before this `yield*`
   * returns, a `getProvidersSnapshot` read taken afterwards cannot miss
   * an update published in between — it replays from the subscription.
   * Publications carry the registry revision stamped at publish time;
   * fence replayed entries at-or-below the snapshot's revision.
   */
  readonly subscribeChanges: Effect.Effect<
    PubSub.Subscription<ProviderRegistrySnapshot>,
    never,
    Scope.Scope
  >;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "t3/provider/Services/ProviderRegistry",
) {}

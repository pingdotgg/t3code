/**
 * ProviderAdapterRegistry - Lookup boundary for provider adapter implementations.
 *
 * Maps a `ProviderInstanceId` (the new per-instance routing key) or a
 * `ProviderDriverKind` (legacy single-instance-per-driver key) to the concrete
 * adapter service (Codex, Claude, etc). It does not own session lifecycle
 * or routing rules; `ProviderService` uses this registry together with
 * `ProviderSessionDirectory`.
 *
 * During the driver/instance migration this tag exposes both flavours:
 *
 *   - `getByInstance` / `listInstances` — new per-instance routing. Callers
 *     that already know an `instanceId` (threads, sessions, events)
 *     should prefer these.
 *   - `listProviders` — legacy kind-keyed routing for default instances
 *     (`defaultInstanceIdForDriver(kind) === kind`), matching the pre-Slice-D
 *     behaviour. New code should not grow additional callers of the kind-keyed
 *     methods; they exist so the settings UI, WS refresh RPC, and a handful
 *     of legacy persisted rows can still be routed during the rollout.
 *
 * Adapter lookups are resolved dynamically through `ProviderInstanceRegistry`.
 * Settings-driven hot reload is therefore visible immediately without
 * rebuilding this facade.
 *
 * @module ProviderAdapterRegistry
 */
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import { ProviderUnsupportedError, type ProviderAdapterError } from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import type { ProviderContinuationIdentity } from "./ProviderDriver.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

export interface ProviderInstanceRoutingInfo {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly continuationIdentity: ProviderContinuationIdentity;
}

export class ProviderAdapterRegistry extends Context.Service<
  ProviderAdapterRegistry,
  {
    /**
     * Resolve the adapter for a specific instance id. Returns
     * `ProviderUnsupportedError` if no such instance is currently registered
     * (which covers "never configured" and "configured but the driver is
     * unavailable in this build"; both surface the same failure to callers
     * that expect a working adapter).
     */
    readonly getByInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderUnsupportedError>;

    /** Resolve routing metadata for a specific live provider instance. */
    readonly getInstanceInfo: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderUnsupportedError>;

    /**
     * List all live instance ids. Excludes unavailable/shadow instances because
     * callers of this method want something they can pass to `getByInstance`.
     */
    readonly listInstances: () => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;

    /**
     * List provider kinds whose default instance is currently registered.
     *
     * @deprecated Prefer `listInstances`. Retained for migration-era call sites
     * that iterate providers to build UI or metrics.
     */
    readonly listProviders: () => Effect.Effect<ReadonlyArray<ProviderDriverKind>>;

    /**
     * Change notification stream mirroring
     * `ProviderInstanceRegistry.streamChanges`. Emits one `void` tick whenever
     * the set of live instances changes. Consumers that fan out
     * `adapter.streamEvents` per instance re-pull `listInstances` on each tick
     * and fork subscriptions for instances they have not seen yet.
     */
    readonly streamChanges: Stream.Stream<void>;

    /**
     * Acquire a change subscription synchronously in the caller's current
     * fiber. Consumers that must avoid missing a publish between initial
     * reconciliation and watcher startup should use this, then fork
     * `Stream.fromSubscription`.
     */
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/provider/ProviderAdapterRegistry") {}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const getByInstance: ProviderAdapterRegistry["Service"]["getByInstance"] = (instanceId) =>
    registry
      .getInstance(instanceId)
      .pipe(
        Effect.flatMap((instance) =>
          instance === undefined
            ? Effect.fail(new ProviderUnsupportedError({ provider: instanceId }))
            : Effect.succeed(instance.adapter),
        ),
      );

  const getInstanceInfo: ProviderAdapterRegistry["Service"]["getInstanceInfo"] = (instanceId) =>
    registry.getInstance(instanceId).pipe(
      Effect.flatMap((instance) =>
        instance === undefined
          ? Effect.fail(new ProviderUnsupportedError({ provider: instanceId }))
          : Effect.succeed({
              instanceId: instance.instanceId,
              driverKind: instance.driverKind,
              displayName: instance.displayName,
              accentColor: instance.accentColor,
              enabled: instance.enabled,
              continuationIdentity: instance.continuationIdentity,
            }),
      ),
    );

  const listInstances: ProviderAdapterRegistry["Service"]["listInstances"] = () =>
    registry.listInstances.pipe(
      Effect.map((instances) => instances.map((instance) => instance.instanceId)),
    );

  const listProviders: ProviderAdapterRegistry["Service"]["listProviders"] = () =>
    registry.listInstances.pipe(
      Effect.map((instances) => {
        const kinds = new Set<ProviderDriverKind>();
        for (const instance of instances) {
          if (instance.instanceId === defaultInstanceIdForDriver(instance.driverKind)) {
            // Only default instances appear through this legacy view; custom
            // instances such as `codex_personal` have no driver-kind identity.
            kinds.add(instance.driverKind);
          }
        }
        return Array.from(kinds);
      }),
    );

  return ProviderAdapterRegistry.of({
    getByInstance,
    getInstanceInfo,
    listInstances,
    listProviders,
    // The facade owns no state; the instance registry already coalesces
    // add, remove, and rebuild notifications into a single change channel.
    streamChanges: registry.streamChanges,
    subscribeChanges: registry.subscribeChanges,
  });
});

export const layer = Layer.effect(ProviderAdapterRegistry, make);

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
 *     (`defaultInstanceIdForDriver(kind) === kind`), matching the pre-Slice-D
 *     behaviour. New code should not grow additional callers of the kind-keyed
 *     methods; they exist so the settings UI, WS refresh RPC, and a handful
 *     of legacy persisted rows can still be routed during the rollout.
 *
 * @module ProviderAdapterRegistry
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, PubSub, Scope, Stream } from "effect";

import type { ProviderAdapterError, ProviderUnsupportedError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import type { ProviderContinuationIdentity } from "../ProviderDriver.ts";

export interface ProviderInstanceRoutingInfo {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly continuationIdentity: ProviderContinuationIdentity;
}

/**
 * ProviderAdapterRegistryShape - Service API for adapter lookup.
 */
export interface ProviderAdapterRegistryShape {
  /**
   * Resolve the adapter for a specific instance id. Returns
   * `ProviderUnsupportedError` if no such instance is currently registered
   * (which covers "never configured" *and* "configured but the driver is
   * unavailable in this build" — both surface the same failure to callers
   * that expect a working adapter).
   */
  readonly getByInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderUnsupportedError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderUnsupportedError>;

  /**
   * List all live instance ids. Excludes unavailable/shadow instances —
   * callers of this method want something they can pass to `getByInstance`.
   */
  readonly listInstances: () => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;

  /**
   * Legacy: list provider kinds whose default instance is currently
   * registered.
   *
   * @deprecated Prefer `listInstances`. Retained for migration-era call
   * sites that iterate providers to build UI/metrics.
   */
  readonly listProviders: () => Effect.Effect<ReadonlyArray<ProviderDriverKind>>;

  /**
   * Change notification stream mirroring `ProviderInstanceRegistry.streamChanges`.
   * Emits one `void` tick whenever the set of live instances changes
   * (instance added, removed, or rebuilt after a settings edit). Consumers
   * that fan out `adapter.streamEvents` per instance — e.g. `ProviderService`'s
   * runtime event bus — re-pull `listInstances` on each tick and fork new
   * subscriptions for instances they haven't seen yet.
   */
  readonly streamChanges: Stream.Stream<void>;

  /**
   * Acquire a change subscription synchronously in the caller's current fiber.
   * Consumers that must avoid missing a publish between initial reconciliation
   * and watcher startup should use this, then fork `Stream.fromSubscription`.
   */
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
}

/**
 * ProviderAdapterRegistry - Service tag for provider adapter lookup.
 */
export class ProviderAdapterRegistry extends Context.Service<
  ProviderAdapterRegistry,
  ProviderAdapterRegistryShape
>()("t3/provider/Services/ProviderAdapterRegistry") {}

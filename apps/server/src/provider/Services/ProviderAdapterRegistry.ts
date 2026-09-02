/**
 * ProviderAdapterRegistry - Lookup boundary for provider adapter implementations.
 *
 * Maps a `ProviderInstanceId` to its provider adapter. `ProviderService` uses
 * this registry with `ProviderSessionDirectory`. The registry does not own
 * session lifecycle or routing rules.
 *
 * @module ProviderAdapterRegistry
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

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

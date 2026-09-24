/**
 * ProviderAdapterRegistryLive — facade over `ProviderInstanceRegistry`.
 *
 * `ProviderAdapterRegistry` historically mapped one `ProviderDriverKind` to one
 * adapter via the four `<X>AdapterLive` singleton Layers. The per-instance
 * refactor moved adapter construction inside each `ProviderDriver.create()`:
 * adapters are now bundled on the `ProviderInstance` that the
 * `ProviderInstanceRegistry` owns.
 *
 * This facade fulfills the `ProviderAdapterRegistryShape` contract by doing
 * dynamic look-ups against `ProviderInstanceRegistry` on every call. That
 * means settings-driven hot-reload shows up here automatically — adding a
 * new instance via settings makes `getByInstance` resolve immediately
 * without rebuilding the facade.
 *
 * @module ProviderAdapterRegistryLive
 */
import { ProviderInstanceId, ProviderSetupError, type ProviderSession } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import {
  ProviderUnsupportedError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";

import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const isSetupError = Schema.is(ProviderSetupError);

const makeProviderAdapterRegistry = Effect.fn("makeProviderAdapterRegistry")(function* () {
  const registry = yield* ProviderInstanceRegistry;
  // Stable identity keeps ProviderService's event subscriptions attached once.
  const guarded = new WeakMap<ProviderInstance, ProviderAdapterShape<ProviderAdapterError>>();
  const guard = (instance: ProviderInstance) => {
    const auth = instance.auth;
    if (!auth || (!auth.withAccess && !auth.isChangingCredentials && !auth.credentialBinding))
      return instance.adapter;
    const cached = guarded.get(instance);
    if (cached) return cached;
    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      ...instance.adapter,
      startSession: (input) => {
        const start = Effect.gen(function* () {
          const binding = auth.credentialBinding;
          const related = binding
            ? (yield* registry.listInstances).filter(
                (peer) =>
                  peer.auth?.credentialBinding?.key === binding.key &&
                  peer.auth.credentialBinding.owner === binding.owner,
              )
            : [instance];
          for (const peer of related) {
            if (peer.auth?.isChangingCredentials && (yield* peer.auth.isChangingCredentials)) {
              return yield* new ProviderSetupError({
                instanceId: instance.instanceId,
                operation: "session",
                detail: "Provider sign-in is changing. Try again after it finishes.",
              });
            }
          }
          let admitted: Effect.Effect<
            ProviderSession,
            ProviderAdapterError | ProviderSetupError,
            Scope.Scope
          > = instance.adapter.startSession(input);
          // Every shared owner holds the startup scope. A credential change
          // interrupts admitted startup before it can escape the session drain.
          for (const peer of related) {
            if (peer.auth?.withAccess) admitted = peer.auth.withAccess(admitted);
          }
          return yield* Effect.scoped(admitted);
        });
        // Adapters own established session lifetimes. This scope guards startup;
        // ProviderAuthService drains routed sessions before changing credentials.
        return start.pipe(
          Effect.mapError((cause) =>
            isSetupError(cause)
              ? new ProviderAdapterValidationError({
                  provider: instance.driverKind,
                  operation: "startSession",
                  issue: cause.detail,
                })
              : cause,
          ),
        );
      },
    };
    guarded.set(instance, adapter);
    return adapter;
  };

  const getByInstance: ProviderAdapterRegistryShape["getByInstance"] = (instanceId) =>
    registry.getInstance(instanceId).pipe(
      Effect.flatMap((instance) =>
        instance === undefined
          ? Effect.fail(
              new ProviderUnsupportedError({
                provider: instanceId,
              }),
            )
          : Effect.succeed(guard(instance)),
      ),
    );

  const getInstanceInfo: ProviderAdapterRegistryShape["getInstanceInfo"] = (instanceId) =>
    registry.getInstance(instanceId).pipe(
      Effect.flatMap((instance) =>
        instance === undefined
          ? Effect.fail(
              new ProviderUnsupportedError({
                provider: instanceId,
              }),
            )
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

  const listInstances: ProviderAdapterRegistryShape["listInstances"] = () =>
    registry.listInstances.pipe(
      Effect.map((instances) => instances.map((instance) => instance.instanceId)),
    );

  return {
    getByInstance,
    getInstanceInfo,
    listInstances,
    subscribeChanges: registry.subscribeChanges,
  } satisfies ProviderAdapterRegistryShape;
});

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistry(),
);

// Re-export for consumers (including tests) that construct a
// `ProviderInstanceId` before calling `getByInstance`.
export { ProviderInstanceId };

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
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderUnsupportedError, ProviderValidationError } from "../Errors.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";

const makeProviderAdapterRegistry = Effect.fn("makeProviderAdapterRegistry")(function* () {
  const registry = yield* ProviderInstanceRegistry;

  const getByInstance: ProviderAdapterRegistryShape["getByInstance"] = (instanceId) =>
    registry.getInstance(instanceId).pipe(
      Effect.flatMap((instance) =>
        instance === undefined
          ? Effect.fail(
              new ProviderUnsupportedError({
                provider: instanceId,
              }),
            )
          : Effect.succeed(instance.adapter),
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

  const getSkills: ProviderAdapterRegistryShape["getSkills"] = Effect.fn("getSkills")(
    function* (instanceId, cwd) {
      const instance = yield* registry.getInstance(instanceId);
      if (!instance || !instance.enabled)
        return yield* new ProviderUnsupportedError({ provider: instanceId });
      const snapshot = yield* (
        cwd !== undefined && instance.snapshotForCwd
          ? instance.snapshotForCwd(cwd)
          : instance.snapshot.refresh
      ).pipe(
        Effect.mapError(
          () =>
            new ProviderValidationError({
              operation: "ProviderService.sendTurn",
              issue: "Cannot discover the selected provider's skills. Refresh skills and retry.",
            }),
        ),
      );
      if (snapshot.status === "error")
        return yield* new ProviderValidationError({
          operation: "ProviderService.sendTurn",
          issue: "Cannot discover the selected provider's skills. Refresh skills and retry.",
        });
      return snapshot.skills;
    },
  );
  const listInstances: ProviderAdapterRegistryShape["listInstances"] = () =>
    registry.listInstances.pipe(
      Effect.map((instances) => instances.map((instance) => instance.instanceId)),
    );

  return {
    getByInstance,
    getSkills,
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

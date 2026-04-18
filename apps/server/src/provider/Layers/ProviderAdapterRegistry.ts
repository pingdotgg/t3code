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
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderUnsupportedError } from "../Errors.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";

const makeProviderAdapterRegistry = Effect.fn("makeProviderAdapterRegistry")(function* () {
  const registry = yield* ProviderInstanceRegistry;

const makeProviderAdapterRegistry = Effect.fn("makeProviderAdapterRegistry")(function* (
  options?: ProviderAdapterRegistryLiveOptions,
) {
  const cursorAdapterOption = yield* Effect.serviceOption(CursorAdapter);
  const adapters =
    options?.adapters !== undefined
      ? options.adapters
      : [
          yield* CodexAdapter,
          yield* ClaudeAdapter,
          yield* OpenCodeAdapter,
          ...(cursorAdapterOption._tag === "Some" ? [cursorAdapterOption.value] : []),
        ];
  const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));

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

  const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
    registry.listInstances.pipe(
      Effect.map((instances) => {
        const kinds = new Set<ProviderDriverKind>();
        for (const instance of instances) {
          const defaultId = defaultInstanceIdForDriver(instance.driverKind);
          if (instance.instanceId === defaultId) {
            // Only the default-instance rows show up through the legacy
            // shim — custom instances like `codex_personal` have no
            // `ProviderDriverKind` equivalent.
            kinds.add(instance.driverKind);
          }
        }
        return Array.from(kinds);
      }),
    );

  return {
    getByInstance,
    getInstanceInfo,
    listInstances,
    listProviders,
    // Proxy directly — the facade has no state of its own; the instance
    // registry already coalesces adds/removes/rebuilds into one emission.
    streamChanges: registry.streamChanges,
    subscribeChanges: registry.subscribeChanges,
  } satisfies ProviderAdapterRegistryShape;
});

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistry(),
);

// Exposed for tests that want to build a facade over a pre-assembled
// `ProviderInstanceRegistry` without pulling in the whole boot graph.
export { makeProviderAdapterRegistry };

// Re-export for consumers that need the accessor shape. The service tag
// itself lives in `Services/ProviderAdapterRegistry.ts`.
export { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
// Re-export for consumers (including tests) that construct a
// `ProviderInstanceId` before calling `getByInstance`.
export { ProviderInstanceId };

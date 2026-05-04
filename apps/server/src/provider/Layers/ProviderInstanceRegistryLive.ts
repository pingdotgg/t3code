/**
 * ProviderInstanceRegistryLive — runtime implementation of
 * `ProviderInstanceRegistry` plus its sibling mutator.
 *
 * Materializes every entry in a `ProviderInstanceConfigMap`:
 *
 *   - When the entry's `driver` matches a registered driver, the registry
 *     decodes the opaque `config` envelope through `driver.configSchema`
 *     and calls `driver.create()` inside a fresh child scope. The
 *     resulting `ProviderInstance` is stored keyed by instance id,
 *     alongside its scope so the entry can be torn down independently.
 *   - When the entry's `driver` is unknown to this build (fork, rollback,
 *     in-flight PR branch), the registry emits an `"unavailable"` shadow
 *     `ServerProvider` snapshot instead of failing. This is what makes
 *     downgrades and fork-hopping safe per the
 *     `forward/backward compatibility invariant` in
 *     `packages/contracts/src/providerInstance.ts`.
 *   - When the entry's config fails schema decode, the registry logs and
 *     emits a shadow snapshot with the schema detail — same bucket as an
 *     unknown driver.
 *
 * Unlike the pre-Slice-D layer, the registry now holds mutable state
 * (`Ref`s + `PubSub`) and exposes an internal mutator
 * (`ProviderInstanceRegistryMutator`) whose `reconcile` method diffs a
 * fresh config map against the live state, tearing down removed instances
 * and building new ones without disturbing unaffected instances.
 *
 * Every live instance runs inside its own child `Scope`. The registry's
 * own scope owns all child scopes via finalizers, so closing the registry
 * tears every instance down in reverse order; closing a single instance
 * (via `reconcile` removing it) leaves the rest untouched.
 *
 * @module provider/Layers/ProviderInstanceRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { Context, Effect, Equal, Exit, Layer, PubSub, Ref, Schema, Scope, Stream } from "effect";

import { buildUnavailableProviderSnapshot } from "../unavailableProviderSnapshot.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderInstanceRegistryMutator,
  type ProviderInstanceRegistryMutatorShape,
} from "../Services/ProviderInstanceRegistryMutator.ts";
import type { AnyProviderDriver, ProviderInstance } from "../ProviderDriver.ts";

/**
 * Live registry entry: the materialized `ProviderInstance` + the fresh
 * child scope its `create` effect ran in + the original `entry` envelope
 * so `reconcile` can cheaply detect "no-op" updates.
 */
interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
}

/**
 * Internal state shared between the public registry service and the
 * mutator service. Both services are thin shells around these refs.
 */
interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
  readonly changes: PubSub.PubSub<void>;
}

/**
 * Structural equality on `ProviderInstanceConfig` envelopes. Used by
 * `reconcile` to skip rebuilds when settings arrive unchanged. Config
 * payloads are opaque `unknown` at the envelope layer; `Equal.equals`
 * falls back to structural equality for plain records, which matches how
 * the schema decode output is constructed.
 */
const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);

const decodedConfigEnabled = (config: unknown): boolean | undefined => {
  if (!config || typeof config !== "object" || globalThis.Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/**
 * Build one live entry from a raw config envelope. Returns either a
 * `LiveEntry` plus undefined unavailable shadow, or a shadow snapshot and
 * undefined entry — callers dispatch to the appropriate Ref bucket.
 */
const buildEntry = <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
}): Effect.Effect<
  | { readonly kind: "live"; readonly live: LiveEntry }
  | { readonly kind: "unavailable"; readonly snapshot: ServerProvider },
  never,
  R
> =>
  Effect.gen(function* () {
    const { driversById, parentScope, instanceId, rawInstanceId, entry } = input;
    const driver = driversById.get(entry.driver);
    if (!driver) {
      return {
        kind: "unavailable" as const,
        snapshot: buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          iconUrl: entry.iconUrl,
          reason: `Driver '${entry.driver}' is not registered in this build.`,
        }),
      };
    }

    const decoder = Schema.decodeUnknownEffect(driver.configSchema);
    const decodeResult = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.result);
    if (decodeResult._tag === "Failure") {
      const issue = decodeResult.failure;
      const detail = issue.message ?? String(issue);
      yield* Effect.logError("Failed to decode provider instance config", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail,
      });
      return {
        kind: "unavailable" as const,
        snapshot: buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          iconUrl: entry.iconUrl,
          reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
        }),
      };
    }

    const typedConfig = decodeResult.success;
    const childScope = yield* Scope.make();
    // Attach the child scope to the registry's parent scope: if the
    // registry scope closes, each surviving instance's child scope is
    // closed through this finalizer. `reconcile` manually closes the
    // child scope on remove/replace; subsequent close via the parent's
    // finalizer is a no-op because `Scope.close` is idempotent.
    yield* Scope.addFinalizer(parentScope, Scope.close(childScope, Exit.void).pipe(Effect.ignore));

    const createResult = yield* driver
      .create({
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        iconUrl: entry.iconUrl,
        environment: entry.environment ?? [],
        enabled: entry.enabled ?? decodedConfigEnabled(typedConfig) ?? true,
        config: typedConfig,
      })
      .pipe(Effect.provideService(Scope.Scope, childScope), Effect.result);
    if (createResult._tag === "Failure") {
      yield* Effect.logError("Failed to create provider instance", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail: createResult.failure.detail,
      });
      yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
      return {
        kind: "unavailable" as const,
        snapshot: buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          iconUrl: entry.iconUrl,
          reason: `Driver '${entry.driver}' failed to create instance: ${createResult.failure.detail}`,
        }),
      };
    }

    return {
      kind: "live" as const,
      live: {
        instance: createResult.success,
        scope: childScope,
        entry,
      },
    };
  });

/**
 * Reconcile-only implementation of the mutator. Exposed to the hydration
 * layer; never called directly by the rest of the server.
 */
const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
}): ((configMap: ProviderInstanceConfigMap) => Effect.Effect<void, never, R>) => {
  const { state, driversById, parentScope } = input;
  return (configMap: ProviderInstanceConfigMap) =>
    Effect.gen(function* () {
      const previousEntries = yield* Ref.get(state.entries);
      const previousUnavailable = yield* Ref.get(state.unavailable);
      const nextRaw = Object.entries(configMap);
      const nextKeys = new Set<ProviderInstanceId>(
        nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
      );

      // 1. Close scopes for instances that disappeared or whose config
      //    changed. Do this BEFORE creating replacements so ids map 1-to-1
      //    to live scopes at all times.
      const removedIds: Array<ProviderInstanceId> = [];
      const replacedIds = new Set<ProviderInstanceId>();
      for (const [instanceId, live] of previousEntries) {
        if (!nextKeys.has(instanceId)) {
          removedIds.push(instanceId);
          continue;
        }
        const nextEntry = configMap[instanceId];
        if (nextEntry !== undefined && !entryEqual(live.entry, nextEntry)) {
          replacedIds.add(instanceId);
        }
      }
      for (const id of [...removedIds, ...replacedIds]) {
        const live = previousEntries.get(id);
        if (live) {
          yield* Scope.close(live.scope, Exit.void).pipe(Effect.ignore);
        }
      }

      // 2. Build additions and replacements. Walk `nextRaw` so the final
      //    entry order follows settings-author order.
      const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
      const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
      let orderChanged = false;
      const previousOrder = [...previousEntries.keys()];
      const nextOrder: Array<ProviderInstanceId> = [];

      for (const [rawInstanceId, entry] of nextRaw) {
        const instanceId = ProviderInstanceId.make(rawInstanceId);
        nextOrder.push(instanceId);

        const existing = previousEntries.get(instanceId);
        if (existing !== undefined && !replacedIds.has(instanceId)) {
          // No-op update: keep the existing live entry and scope.
          builtEntries.set(instanceId, existing);
          continue;
        }

        const result = yield* buildEntry({
          driversById,
          parentScope,
          instanceId,
          rawInstanceId,
          entry,
        });
        if (result.kind === "live") {
          builtEntries.set(instanceId, result.live);
        } else {
          builtUnavailable.set(instanceId, result.snapshot);
        }
      }

      if (previousOrder.length === nextOrder.length) {
        for (let i = 0; i < previousOrder.length; i++) {
          if (previousOrder[i] !== nextOrder[i]) {
            orderChanged = true;
            break;
          }
        }
      } else {
        orderChanged = true;
      }

      const entriesChanged =
        orderChanged ||
        removedIds.length > 0 ||
        replacedIds.size > 0 ||
        builtEntries.size !== previousEntries.size;
      const unavailableChanged =
        builtUnavailable.size !== previousUnavailable.size ||
        [...builtUnavailable].some(([id, snapshot]) => {
          const prev = previousUnavailable.get(id);
          return prev === undefined || !Equal.equals(prev, snapshot);
        }) ||
        [...previousUnavailable].some(([id]) => !builtUnavailable.has(id));

      yield* Ref.set(state.entries, builtEntries);
      yield* Ref.set(state.unavailable, builtUnavailable);

      if (entriesChanged || unavailableChanged) {
        yield* PubSub.publish(state.changes, undefined);
      }
    });
};

/**
 * Build the registry's runtime state from a concrete configMap. Returns a
 * record containing:
 *
 *   - `registry`: the read-only `ProviderInstanceRegistryShape` to expose
 *     under `ProviderInstanceRegistry`.
 *   - `mutator`: the `ProviderInstanceRegistryMutatorShape` to expose
 *     under `ProviderInstanceRegistryMutator`.
 *   - `reconcile`: the raw reconcile function, provided for convenience so
 *     boot-time layers can hydrate an initial map before publishing the
 *     services.
 *
 * The scope that this effect runs in owns every per-instance child scope
 * created during `reconcile`. Closing that scope closes every live
 * instance.
 */
export const makeProviderInstanceRegistry = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<
  {
    readonly registry: ProviderInstanceRegistryShape;
    readonly mutator: ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
      input.drivers.map((driver) => [driver.driverKind, driver]),
    );

    // Capture the enclosing scope so per-instance child scopes can be
    // attached to it at `reconcile` time. Without this, `reconcile`
    // called later (e.g. from the hydration layer) would attach child
    // scopes to the *caller's* scope instead of the registry's.
    const parentScope = yield* Scope.Scope;

    // Capture the driver R context at construction time so `reconcile`
    // can be invoked later without re-providing driver dependencies.
    // The service tag's declared `reconcile: Effect<void>` hides R from
    // consumers — we materialize that here.
    const driverContext = yield* Effect.context<R>();

    const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
    const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
    const changes = yield* PubSub.unbounded<void>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    const state: RegistryState = { entries, unavailable, changes };
    const reconcileWithR = makeReconcile({ state, driversById, parentScope });
    const reconcile: ProviderInstanceRegistryMutatorShape["reconcile"] = (configMap) =>
      reconcileWithR(configMap).pipe(Effect.provideContext(driverContext));

    // Hydrate the initial configMap synchronously so callers can read
    // `listInstances` immediately after this effect completes.
    yield* reconcile(input.configMap);

    const registry: ProviderInstanceRegistryShape = {
      getInstance: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id)?.instance)),
      listInstances: Ref.get(entries).pipe(
        Effect.map(
          (map) =>
            Array.from(map.values(), (live) => live.instance) as ReadonlyArray<ProviderInstance>,
        ),
      ),
      listUnavailable: Ref.get(unavailable).pipe(
        Effect.map((map) => Array.from(map.values()) as ReadonlyArray<ServerProvider>),
      ),
      // Getters: each read constructs a fresh Stream / Effect descriptor
      // so multiple consumers don't share a single already-started
      // Channel or subscription. Matches the pattern `ProviderRegistry`
      // uses for its own `streamChanges`.
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      // Synchronous subscribe — callers that need to consume changes
      // from a forked fibre must acquire the subscription in their own
      // fibre first (via `yield* registry.subscribeChanges`) and only
      // then fork a consumer loop on `Stream.fromSubscription(...)` /
      // `PubSub.take(...)`. See the shape docs for the race this avoids.
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    };

    const mutator: ProviderInstanceRegistryMutatorShape = { reconcile };

    return { registry, mutator };
  });

/**
 * Assemble a `ProviderInstanceRegistry` Layer bound to a fixed set of
 * drivers and a pre-resolved `ProviderInstanceConfigMap`. Used by tests
 * that want explicit control over the registry's source-of-truth without
 * wiring up the settings watcher.
 *
 * Only exposes the public registry tag — hot-reload consumers should use
 * `ProviderInstanceRegistryMutableLayer` (below) or the hydration layer.
 */
export const ProviderInstanceRegistryLayer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<ProviderInstanceRegistry, never, R> =>
  Layer.effect(
    ProviderInstanceRegistry,
    makeProviderInstanceRegistry(input).pipe(Effect.map((built) => built.registry)),
  ) as Layer.Layer<ProviderInstanceRegistry, never, R>;

/**
 * Layer variant that also exposes the mutator tag. Consumed by
 * `ProviderInstanceRegistryHydrationLive` to reconcile on settings
 * changes. Tests that exercise the mutator directly can pair this Layer
 * with a test-local `ServerSettingsService`.
 */
export const ProviderInstanceRegistryMutableLayer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<ProviderInstanceRegistry | ProviderInstanceRegistryMutator, never, R> =>
  Layer.effectContext(
    makeProviderInstanceRegistry(input).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  ) as Layer.Layer<ProviderInstanceRegistry | ProviderInstanceRegistryMutator, never, R>;

export { defaultInstanceIdForDriver };

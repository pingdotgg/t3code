/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * The server still reads two shapes:
 *
 *   1. `settings.providerInstances` — the new driver-agnostic map the
 *      registry expects. Keyed by `ProviderInstanceId`, values are
 *      `ProviderInstanceConfig` envelopes.
 *   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
 *      fields (`providers.codex`, `providers.claudeAgent`, …). These are
 *      the source of truth for every deployment that hasn't been migrated
 *      yet to an explicit `providerInstances` entry.
 *
 * This module bridges (2) into (1) and wires the resulting map into a
 * mutable registry. For every built-in driver whose id is not already
 * present in `providerInstances` (keyed on
 * `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
 * routing slug), we synthesize an envelope from the legacy field. The
 * registry decodes both flavours through the same `configSchema` and ends
 * up with one uniform `ProviderInstance` per entry.
 *
 * Explicit `providerInstances` entries always win — users can already
 * override the legacy `providers.<kind>` blob by authoring a
 * `providerInstances.codex` entry with a matching driver, and we don't
 * want the synthesized envelope to silently stomp their config.
 *
 * Hot-reload
 * ----------
 * On layer build we:
 *   1. Read the current `ServerSettings` once and use it to seed the
 *      registry's initial state via `ProviderInstanceRegistryMutableLayer`.
 *   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
 *      subscribes to `ServerSettingsService.streamChanges` and calls
 *      `ProviderInstanceRegistryMutator.reconcile` on every emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/Layers/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  HermesSessionBindingRepository,
  HermesSessionBindingRepositoryError,
} from "../../hermes/HermesSessionBindingRepository.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "../builtInDrivers.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";
import {
  type ProviderOrchestrationAdapterInfrastructure,
  ProviderOrchestrationAdapterInfrastructureLive,
} from "./ProviderOrchestrationAdapterInfrastructure.ts";

// Hermes persistence is late-bound by the production server wrapper. Keeping
// it out of this base layer's public environment lets non-Hermes test/build
// compositions hydrate the other built-in drivers without constructing a
// database-backed Hermes repository.
type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      ProviderOrchestrationAdapterInfrastructure | HermesSessionBindingRepository
    >
  | ServerSettingsService;

const unavailableHermesRepositoryOperation = <A>(
  operation: string,
): Effect.Effect<A, HermesSessionBindingRepositoryError> =>
  Effect.fail(
    new HermesSessionBindingRepositoryError({
      operation,
      detail: "Hermes persistence was not supplied to this runtime composition.",
    }),
  );

const UnavailableHermesSessionBindingRepository = HermesSessionBindingRepository.of({
  createBinding: () => unavailableHermesRepositoryOperation("createBinding"),
  getByThreadId: () => unavailableHermesRepositoryOperation("getByThreadId"),
  getByStoredIdentity: () => unavailableHermesRepositoryOperation("getByStoredIdentity"),
  updateNegotiation: () => unavailableHermesRepositoryOperation("updateNegotiation"),
  updateReconciliation: () => unavailableHermesRepositoryOperation("updateReconciliation"),
  updateTitleState: () => unavailableHermesRepositoryOperation("updateTitleState"),
  acquireOwnerLease: () => unavailableHermesRepositoryOperation("acquireOwnerLease"),
  renewOwnerLease: () => unavailableHermesRepositoryOperation("renewOwnerLease"),
  releaseOwnerLease: () => unavailableHermesRepositoryOperation("releaseOwnerLease"),
  prepareMutationIntent: () => unavailableHermesRepositoryOperation("prepareMutationIntent"),
  setSessionImportInheritedCount: () =>
    unavailableHermesRepositoryOperation("setSessionImportInheritedCount"),
  prepareSessionCreateIntent: () =>
    unavailableHermesRepositoryOperation("prepareSessionCreateIntent"),
  transitionSessionCreateIntent: () =>
    unavailableHermesRepositoryOperation("transitionSessionCreateIntent"),
  transitionMutationIntent: () => unavailableHermesRepositoryOperation("transitionMutationIntent"),
  getMutationIntent: () => unavailableHermesRepositoryOperation("getMutationIntent"),
  listUnsettledMutationIntents: () =>
    unavailableHermesRepositoryOperation("listUnsettledMutationIntents"),
  prepareSessionImport: () => unavailableHermesRepositoryOperation("prepareSessionImport"),
  getSessionImportByStoredIdentity: () =>
    unavailableHermesRepositoryOperation("getSessionImportByStoredIdentity"),
  getMainSessionImport: () => unavailableHermesRepositoryOperation("getMainSessionImport"),
  transitionSessionImport: () => unavailableHermesRepositoryOperation("transitionSessionImport"),
  listHistoryThreadIds: () => unavailableHermesRepositoryOperation("listHistoryThreadIds"),
  clearHistoryRecords: () => unavailableHermesRepositoryOperation("clearHistoryRecords"),
});

const remoteHermesEnabled = (settings: ServerSettings, config: unknown): boolean => {
  if (typeof config !== "object" || config === null) return true;
  const endpoint = Reflect.get(config, "endpoint");
  if (typeof endpoint !== "string" || endpoint.trim() === "") return true;
  let remote = true;
  try {
    remote = !["127.0.0.1", "localhost", "::1"].includes(new URL(endpoint).hostname);
  } catch {
    // Invalid endpoints remain visible to the provider's configuration diagnostics.
    return true;
  }
  if (!remote) return true;
  return settings.enableRemoteHermes && Reflect.get(config, "remoteAccessEnabled") === true;
};

/**
 * Synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
 *
 * Strategy:
 *   1. Copy all explicit `settings.providerInstances` entries verbatim.
 *   2. For each built-in driver whose `defaultInstanceIdForDriver(id)` key
 *      is *not* already in the explicit map, synthesize an entry from the
 *      matching legacy `settings.providers.<kind>` blob.
 *
 * The returned map is the input the registry consumes; pure & exported
 * separately so the hydration logic can be exercised by unit tests
 * without layering.
 */
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const [instanceId, entry] of Object.entries(merged)) {
    if (entry.driver !== "hermes") continue;
    // Hermes is intentionally gated twice: the global rollout flag must be
    // enabled and the explicit instance must opt in. Missing `enabled` is
    // therefore false for Hermes even though other providers default it true.
    merged[instanceId] = {
      ...entry,
      enabled:
        settings.enableHermes &&
        entry.enabled === true &&
        remoteHermesEnabled(settings, entry.config),
    };
  }

  for (const driver of BUILT_IN_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) {
      // Explicit `providerInstances` entry for this slot — user-authored
      // config always wins over the legacy mirror.
      continue;
    }

    // Only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      ...(driver.driverKind === "hermes"
        ? {
            enabled:
              settings.enableHermes &&
              legacyConfig.enabled === true &&
              remoteHermesEnabled(settings, legacyConfig),
          }
        : {}),
      config: legacyConfig,
    };
  }

  return merged as ProviderInstanceConfigMap;
};

/**
 * Layer that consumes `ProviderInstanceRegistryMutator` and forks a
 * settings-watcher fiber. The fiber's lifetime is tied to the enclosing
 * layer scope (process lifetime in production), so it is interrupted on
 * shutdown without leaking.
 *
 * Errors inside the watcher are logged and swallowed — the registry's own
 * "unavailable" bucket already absorbs unknown drivers and invalid
 * configs, so the only way the watcher could fail is a settings stream
 * tear-down, which logs and exits cleanly.
 */
const SettingsWatcherLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const mutator = yield* ProviderInstanceRegistryMutator;
    const serverSettings = yield* ServerSettingsService;
    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((next) =>
        mutator
          .reconcile(deriveProviderInstanceConfigMap(next))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
            ),
          ),
      ),
      Effect.forkScoped,
    );
  }),
);

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * The Layer's two halves:
 *   - `ProviderInstanceRegistryMutableLayer` produces the registry +
 *     mutator from the initial config map. Its scope owns every
 *     per-instance child scope created during reconcile.
 *   - `SettingsWatcherLive` consumes the mutator and runs a daemon fiber
 *     in the same scope.
 *
 * Composing via `Layer.provideMerge` makes the watcher's deps available
 * from the mutable layer while still surfacing the registry as an output.
 * The mutator tag is technically also exposed; only this module imports
 * it, so the visibility leak is harmless in practice.
 */
export const ProviderInstanceRegistryHydrationLive: Layer.Layer<
  ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const hermesRepository = yield* Effect.serviceOption(HermesSessionBindingRepository);
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initialSettings);

    const mutableLayer = ProviderInstanceRegistryMutableLayer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          ProviderOrchestrationAdapterInfrastructureLive,
          Layer.succeed(
            HermesSessionBindingRepository,
            Option.getOrElse(hermesRepository, () => UnavailableHermesSessionBindingRepository),
          ),
        ),
      ),
    );

    return SettingsWatcherLive.pipe(Layer.provideMerge(mutableLayer));
  }),
);

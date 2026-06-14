import {
  defaultInstanceIdForDriver,
  ProviderDriverKind as ProviderDriverKindSchema,
  ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderAdapterV2, type ProviderAdapterV2Shape } from "./ProviderAdapter.ts";

export class ProviderAdapterRegistryLookupError extends Schema.TaggedErrorClass<ProviderAdapterRegistryLookupError>()(
  "ProviderAdapterRegistryLookupError",
  {
    provider: ProviderKind,
  },
) {
  override get message(): string {
    return `No orchestration provider adapter is registered for ${this.provider}.`;
  }
}

export const ProviderAdapterRegistryV2Error = Schema.Union([
  ProviderAdapterRegistryLookupError,
  ProviderAdapterDriverCreateError,
]);
export type ProviderAdapterRegistryV2Error = typeof ProviderAdapterRegistryV2Error.Type;

export interface ProviderAdapterRegistryV2Shape {
  readonly get: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterV2Shape, ProviderAdapterRegistryV2Error>;
  readonly list: () => Effect.Effect<ReadonlyArray<ProviderKind>>;
}

export class ProviderAdapterRegistryV2 extends Context.Service<
  ProviderAdapterRegistryV2,
  ProviderAdapterRegistryV2Shape
>()("t3/orchestration-v2/ProviderAdapterRegistry/ProviderAdapterRegistryV2") {}

function makeRegistry(
  adapters: ReadonlyArray<ProviderAdapterV2Shape>,
): ProviderAdapterRegistryV2Shape {
  return {
    get: (provider) =>
      Effect.gen(function* () {
        const adapter = adapters.find((candidate) => candidate.provider === provider);
        if (!adapter) {
          return yield* new ProviderAdapterRegistryLookupError({ provider });
        }
        return adapter;
      }),
    list: () => Effect.succeed(adapters.map((adapter) => adapter.provider as ProviderKind)),
  };
}

export function makeLayer(
  adapters: ReadonlyArray<ProviderAdapterV2Shape>,
): Layer.Layer<ProviderAdapterRegistryV2> {
  return Layer.succeed(
    ProviderAdapterRegistryV2,
    ProviderAdapterRegistryV2.of(makeRegistry(adapters)),
  );
}

export function makeLayerEffect<R, E>(
  adapters: Effect.Effect<ReadonlyArray<ProviderAdapterV2Shape>, E, R>,
): Layer.Layer<ProviderAdapterRegistryV2, E, R> {
  return Layer.effect(
    ProviderAdapterRegistryV2,
    adapters.pipe(Effect.map((entries) => ProviderAdapterRegistryV2.of(makeRegistry(entries)))),
  );
}

export function makeSingleLayer(
  adapter: ProviderAdapterV2Shape,
): Layer.Layer<ProviderAdapterRegistryV2> {
  return makeLayer([adapter]);
}

export function deriveProviderAdapterInstanceConfigMap<R>(input: {
  readonly settings: ServerSettings;
  readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
}): ProviderInstanceConfigMap {
  const merged: Record<string, ProviderInstanceConfig> = {
    ...input.settings.providerInstances,
  };

  for (const driver of input.drivers) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) {
      continue;
    }

    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = input.settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      config: legacyConfig,
    };
  }

  return merged as ProviderInstanceConfigMap;
}

const decodedConfigEnabled = (config: unknown): boolean | undefined => {
  if (!config || typeof config !== "object" || globalThis.Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

interface LiveAdapterEntry {
  readonly adapter: ProviderAdapterV2Shape;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
}

const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);

const makeSettingsReadError = (cause: unknown): ProviderAdapterDriverCreateError =>
  new ProviderAdapterDriverCreateError({
    driver: ProviderDriverKindSchema.make("settings"),
    instanceId: ProviderInstanceId.make("settings"),
    detail: "Failed to read server settings before building provider adapters.",
    cause,
  });

function makeDriversById<R>(
  drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>,
): ReadonlyMap<ProviderDriverKind, AnyProviderAdapterDriver<R>> {
  return new Map<ProviderDriverKind, AnyProviderAdapterDriver<R>>(
    drivers.map((driver) => [driver.driverKind, driver]),
  );
}

const createAdapterEntryFromConfigEntry = Effect.fn(
  "ProviderAdapterRegistry.createAdapterEntryFromConfigEntry",
)(function* <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderAdapterDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly entry: ProviderInstanceConfig;
}): Effect.fn.Return<LiveAdapterEntry, ProviderAdapterDriverCreateError, R> {
  const driver = input.driversById.get(input.entry.driver);
  if (driver === undefined) {
    return yield* new ProviderAdapterDriverCreateError({
      driver: input.entry.driver,
      instanceId: input.instanceId,
      detail: "Unknown provider driver.",
    });
  }

  const decodeConfig = Schema.decodeUnknownEffect(driver.configSchema);
  const typedConfig = yield* decodeConfig(input.entry.config ?? driver.defaultConfig()).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterDriverCreateError({
          driver: input.entry.driver,
          instanceId: input.instanceId,
          detail: "Invalid provider instance config.",
          cause,
        }),
    ),
  );

  const childScope = yield* Scope.make();
  yield* Scope.addFinalizer(
    input.parentScope,
    Scope.close(childScope, Exit.void).pipe(Effect.ignore),
  );

  const adapter = yield* driver
    .create({
      instanceId: input.instanceId,
      displayName: input.entry.displayName,
      accentColor: input.entry.accentColor,
      environment: input.entry.environment ?? [],
      enabled: input.entry.enabled ?? decodedConfigEnabled(typedConfig) ?? true,
      config: typedConfig,
    })
    .pipe(
      Effect.provideService(Scope.Scope, childScope),
      Effect.tapError(() => Scope.close(childScope, Exit.void).pipe(Effect.ignore)),
    );

  return {
    adapter,
    scope: childScope,
    entry: input.entry,
  };
});

const buildAdaptersFromConfigMap = Effect.fn("ProviderAdapterRegistry.buildAdaptersFromConfigMap")(
  function* <R>(input: {
    readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
    readonly configMap: ProviderInstanceConfigMap;
    readonly parentScope: Scope.Scope;
  }): Effect.fn.Return<
    ReadonlyMap<ProviderInstanceId, LiveAdapterEntry>,
    ProviderAdapterRegistryBuildError,
    R
  > {
    const driversById = makeDriversById(input.drivers);
    const adapters = new Map<ProviderInstanceId, LiveAdapterEntry>();

    for (const [rawInstanceId, entry] of Object.entries(input.configMap)) {
      const instanceId = ProviderInstanceId.make(rawInstanceId);
      if (!driversById.has(entry.driver)) {
        yield* Effect.logWarning("Skipping orchestration-v2 provider adapter with unknown driver", {
          instanceId,
          driver: entry.driver,
        });
        continue;
      }

      const adapter = yield* createAdapterEntryFromConfigEntry({
        driversById,
        parentScope: input.parentScope,
        instanceId,
        entry,
      });
      adapters.set(instanceId, adapter);
    }

    return adapters;
  },
);

const closeAdapterEntry = (entry: LiveAdapterEntry): Effect.Effect<void> =>
  Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

export function makeRegistryFromConfigMap<R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<
  ProviderAdapterRegistryV2Shape,
  ProviderAdapterRegistryBuildError,
  R | Scope.Scope
> {
  return Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const entries = yield* buildAdaptersFromConfigMap({ ...input, parentScope });
    return makeRegistry(Array.from(entries.values()).map((entry) => entry.adapter));
  });
}

export function makeDriverLayer<R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<ProviderAdapterRegistryV2, ProviderAdapterRegistryBuildError, R> {
  return Layer.effect(
    ProviderAdapterRegistryV2,
    makeRegistryFromConfigMap(input).pipe(
      Effect.map((registry) => ProviderAdapterRegistryV2.of(registry)),
    ),
  ) as Layer.Layer<ProviderAdapterRegistryV2, ProviderAdapterRegistryBuildError, R>;
}

export function makeDriverLayerFromSettings<R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
}): Layer.Layer<
  ProviderAdapterRegistryV2,
  ProviderAdapterRegistryBuildError,
  R | ServerSettingsService
> {
  return Layer.effect(
    ProviderAdapterRegistryV2,
    Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      const parentScope = yield* Effect.scope;
      const driverContext = yield* Effect.context<R>();
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError((cause) => makeSettingsReadError(cause)),
      );
      const configMap = deriveProviderAdapterInstanceConfigMap({
        settings,
        drivers: input.drivers,
      });
      const initialAdapters = yield* buildAdaptersFromConfigMap({
        drivers: input.drivers,
        configMap,
        parentScope,
      });
      const adaptersRef = yield* Ref.make(initialAdapters);
      const reconcileSemaphore = yield* Semaphore.make(1);
      const driversById = makeDriversById(input.drivers);

      const reconcileConfigMapWithR = Effect.fn("ProviderAdapterRegistry.reconcileConfigMap")(
        function* (
          nextConfigMap: ProviderInstanceConfigMap,
        ): Effect.fn.Return<void, ProviderAdapterRegistryBuildError, R> {
          const previous = yield* Ref.get(adaptersRef);
          const nextEntries = new Map<ProviderInstanceId, LiveAdapterEntry>();
          const staleEntries: Array<LiveAdapterEntry> = [];
          const nextIds = new Set<ProviderInstanceId>();

          for (const [rawInstanceId, entry] of Object.entries(nextConfigMap)) {
            const instanceId = ProviderInstanceId.make(rawInstanceId);
            nextIds.add(instanceId);

            if (!driversById.has(entry.driver)) {
              yield* Effect.logWarning(
                "Skipping orchestration-v2 provider adapter with unknown driver",
                {
                  instanceId,
                  driver: entry.driver,
                },
              );
              continue;
            }

            const existing = previous.get(instanceId);
            if (existing !== undefined && entryEqual(existing.entry, entry)) {
              nextEntries.set(instanceId, existing);
              continue;
            }

            const nextEntry = yield* createAdapterEntryFromConfigEntry({
              driversById,
              parentScope,
              instanceId,
              entry,
            });
            nextEntries.set(instanceId, nextEntry);
            if (existing !== undefined) {
              staleEntries.push(existing);
            }
          }

          for (const [instanceId, existing] of previous) {
            if (!nextIds.has(instanceId)) {
              staleEntries.push(existing);
            }
          }

          yield* Ref.set(adaptersRef, nextEntries);
          for (const entry of staleEntries) {
            yield* closeAdapterEntry(entry);
          }
        },
      );
      const reconcileConfigMap = (nextConfigMap: ProviderInstanceConfigMap) =>
        reconcileConfigMapWithR(nextConfigMap).pipe(Effect.provideContext(driverContext));

      const refreshFromSettings = Effect.fn("ProviderAdapterRegistry.refreshFromSettings")(
        function* (): Effect.fn.Return<void, ProviderAdapterRegistryV2Error, never> {
          const latestSettings = yield* settingsService.getSettings.pipe(
            Effect.mapError((cause) => makeSettingsReadError(cause)),
          );
          yield* reconcileConfigMap(
            deriveProviderAdapterInstanceConfigMap({
              settings: latestSettings,
              drivers: input.drivers,
            }),
          );
        },
      );

      yield* settingsService.streamChanges.pipe(
        Stream.runForEach((nextSettings) =>
          reconcileSemaphore.withPermits(1)(
            reconcileConfigMap(
              deriveProviderAdapterInstanceConfigMap({
                settings: nextSettings,
                drivers: input.drivers,
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Orchestration-v2 provider adapter registry reconcile failed", {
                  cause,
                }),
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      const refreshAndGet = Effect.fn("ProviderAdapterRegistry.refreshAndGet")(function* (
        instanceId: ProviderInstanceId,
      ): Effect.fn.Return<ProviderAdapterV2Shape, ProviderAdapterRegistryV2Error, never> {
        return yield* reconcileSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const cached = (yield* Ref.get(adaptersRef)).get(instanceId);
            if (cached !== undefined) {
              return cached.adapter;
            }

            yield* refreshFromSettings();
            const refreshed = (yield* Ref.get(adaptersRef)).get(instanceId);
            if (refreshed === undefined) {
              return yield* new ProviderAdapterRegistryLookupError({ instanceId });
            }
            return refreshed.adapter;
          }),
        );
      });

      const get = Effect.fn("ProviderAdapterRegistry.get")(function* (
        instanceId: ProviderInstanceId,
      ): Effect.fn.Return<ProviderAdapterV2Shape, ProviderAdapterRegistryV2Error, never> {
        const cached = (yield* Ref.get(adaptersRef)).get(instanceId);
        if (cached !== undefined) {
          return cached.adapter;
        }
        return yield* refreshAndGet(instanceId);
      });

      return ProviderAdapterRegistryV2.of({
        get,
        list: () =>
          Ref.get(adaptersRef).pipe(
            Effect.map((adapters) =>
              Array.from(adapters.values()).map((entry) => entry.adapter.instanceId),
            ),
          ),
      } satisfies ProviderAdapterRegistryV2Shape);
    }),
  );
}

export const layerFromProviderAdapter: Layer.Layer<
  ProviderAdapterRegistryV2,
  never,
  ProviderAdapterV2
> = Layer.effect(
  ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const adapter = yield* ProviderAdapterV2;
    return ProviderAdapterRegistryV2.of({
      get: (provider) =>
        adapter.provider === provider
          ? Effect.succeed(adapter)
          : Effect.fail(new ProviderAdapterRegistryLookupError({ provider })),
      list: () => Effect.succeed([adapter.provider]),
    } satisfies ProviderAdapterRegistryV2Shape);
  }),
);

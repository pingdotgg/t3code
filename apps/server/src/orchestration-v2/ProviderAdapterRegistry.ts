import {
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderAdapterDriverCreateError,
  type AnyProviderAdapterDriver,
} from "./ProviderAdapterDriver.ts";
import { ProviderAdapterV2, type ProviderAdapterV2Shape } from "./ProviderAdapter.ts";

export class ProviderAdapterRegistryLookupError extends Schema.TaggedErrorClass<ProviderAdapterRegistryLookupError>()(
  "ProviderAdapterRegistryLookupError",
  {
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `No orchestration provider adapter is registered for ${this.instanceId}.`;
  }
}

export class ProviderAdapterRegistryMetadataError extends Schema.TaggedErrorClass<ProviderAdapterRegistryMetadataError>()(
  "ProviderAdapterRegistryMetadataError",
  { instanceId: ProviderInstanceId, cause: Schema.Defect() },
) {}

export const ProviderAdapterRegistryV2Error = Schema.Union([
  ProviderAdapterRegistryLookupError,
  ProviderAdapterRegistryMetadataError,
  ProviderAdapterDriverCreateError,
]);
export type ProviderAdapterRegistryV2Error = typeof ProviderAdapterRegistryV2Error.Type;

export interface ProviderAdapterRegistryV2Shape {
  readonly get: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterV2Shape, ProviderAdapterRegistryV2Error>;
  readonly list: () => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly getMetadata?: (instanceId: ProviderInstanceId) => Effect.Effect<
    {
      readonly driver: ProviderAdapterV2Shape["driver"];
      readonly continuationKey: string;
      readonly enabled: boolean;
      readonly capabilities: OrchestrationV2ProviderCapabilities;
    },
    ProviderAdapterRegistryV2Error
  >;
}

export class ProviderAdapterRegistryV2 extends Context.Service<
  ProviderAdapterRegistryV2,
  ProviderAdapterRegistryV2Shape
>()("t3/orchestration-v2/ProviderAdapterRegistry/ProviderAdapterRegistryV2") {}

/**
 * Production facade over the canonical provider-instance registry. Adapter
 * lookup stays dynamic so instance hot reloads and removals are visible
 * without maintaining a second settings watcher or instance map.
 */
export const layerFromProviderInstanceRegistry: Layer.Layer<
  ProviderAdapterRegistryV2,
  never,
  ProviderInstanceRegistry
> = Layer.effect(
  ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry;
    return ProviderAdapterRegistryV2.of({
      get: (instanceId) =>
        instances
          .getInstance(instanceId)
          .pipe(
            Effect.flatMap((instance) =>
              instance === undefined
                ? new ProviderAdapterRegistryLookupError({ instanceId })
                : Effect.succeed(instance.orchestrationAdapter),
            ),
          ),
      list: () =>
        instances.listInstances.pipe(
          Effect.map((available) => available.map((instance) => instance.instanceId)),
        ),
      getMetadata: (instanceId) =>
        Effect.gen(function* () {
          const instance = yield* instances.getInstance(instanceId);
          if (instance === undefined) {
            return yield* new ProviderAdapterRegistryLookupError({ instanceId });
          }
          const capabilities = yield* instance.orchestrationAdapter
            .getCapabilities()
            .pipe(
              Effect.mapError(
                (cause) => new ProviderAdapterRegistryMetadataError({ instanceId, cause }),
              ),
            );
          return {
            driver: instance.driverKind,
            continuationKey: instance.continuationIdentity.continuationKey,
            enabled: instance.enabled,
            capabilities,
          };
        }),
    });
  }),
);

export const ProviderAdapterRegistryBuildError = Schema.Union([ProviderAdapterDriverCreateError]);
export type ProviderAdapterRegistryBuildError = typeof ProviderAdapterRegistryBuildError.Type;

function makeRegistry(
  adapters: ReadonlyArray<ProviderAdapterV2Shape>,
): ProviderAdapterRegistryV2Shape {
  return {
    get: (instanceId) =>
      Effect.gen(function* () {
        const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
        if (!adapter) {
          return yield* new ProviderAdapterRegistryLookupError({ instanceId });
        }
        return adapter;
      }),
    list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
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

export const layerFromProviderAdapter: Layer.Layer<
  ProviderAdapterRegistryV2,
  never,
  ProviderAdapterV2
> = Layer.effect(
  ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const adapter = yield* ProviderAdapterV2;
    return ProviderAdapterRegistryV2.of({
      get: (instanceId) =>
        adapter.instanceId === instanceId
          ? Effect.succeed(adapter)
          : Effect.fail(new ProviderAdapterRegistryLookupError({ instanceId })),
      list: () => Effect.succeed([adapter.instanceId]),
    } satisfies ProviderAdapterRegistryV2Shape);
  }),
);

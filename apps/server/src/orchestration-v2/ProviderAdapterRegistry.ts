import { ProviderKind } from "@t3tools/contracts";
import { Context, Effect, Layer, Schema } from "effect";

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

export const ProviderAdapterRegistryV2Error = Schema.Union([ProviderAdapterRegistryLookupError]);
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
>()("t3/orchestration-v2/ProviderAdapterRegistry") {}

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

export function makeRegistryFromConfigMap<R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<
  ProviderAdapterRegistryV2Shape,
  ProviderAdapterRegistryBuildError,
  R | Scope.Scope
> {
  return Effect.gen(function* () {
    const driversById = new Map<ProviderDriverKind, AnyProviderAdapterDriver<R>>(
      input.drivers.map((driver) => [driver.driverKind, driver]),
    );
    const adapters: Array<ProviderAdapterV2Shape> = [];

    for (const [rawInstanceId, entry] of Object.entries(input.configMap)) {
      const instanceId = ProviderInstanceId.make(rawInstanceId);
      const driver = driversById.get(entry.driver);
      if (driver === undefined) {
        yield* Effect.logWarning("Skipping orchestration-v2 provider adapter with unknown driver", {
          instanceId,
          driver: entry.driver,
        });
        continue;
      }

      const typedConfig = yield* Schema.decodeUnknownEffect(driver.configSchema)(
        entry.config ?? driver.defaultConfig(),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: entry.driver,
              instanceId,
              detail: "Invalid provider instance config.",
              cause,
            }),
        ),
      );

      const adapter = yield* driver.create({
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        environment: entry.environment ?? [],
        enabled: entry.enabled ?? decodedConfigEnabled(typedConfig) ?? true,
        config: typedConfig,
      });
      adapters.push(adapter);
    }

    return makeRegistry(adapters);
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
  return Layer.unwrap(
    Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ProviderDriverKindSchema.make("settings"),
              instanceId: ProviderInstanceId.make("settings"),
              detail: "Failed to read server settings before building provider adapters.",
              cause,
            }),
        ),
      );
      const configMap = deriveProviderAdapterInstanceConfigMap({
        settings,
        drivers: input.drivers,
      });
      return makeDriverLayer({ drivers: input.drivers, configMap });
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

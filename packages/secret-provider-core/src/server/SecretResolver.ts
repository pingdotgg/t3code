// Reads secrets that settings point at through a configured secret provider. Each read, including
// a failed one, is held for the server's life so rebuilds never re-prompt an unlock; `invalidate`
// (the Settings refresh) is the only way to read again.
import type { SecretReference, ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { SecretProviderDriver, SecretProviderDriverServices } from "./driver.ts";

export class SecretResolver extends Context.Service<
  SecretResolver,
  {
    /** Values in input order; `undefined` marks a reference that could not be read. */
    readonly read: (
      references: ReadonlyArray<SecretReference>,
    ) => Effect.Effect<ReadonlyArray<string | undefined>>;
    /** Forgets the given references, or every reference, so the next read asks the provider again. */
    readonly invalidate: (references?: ReadonlyArray<SecretReference>) => Effect.Effect<void>;
  }
>()("@t3tools/secret-provider-core/server/SecretResolver") {}

const cacheKey = (reference: SecretReference) =>
  `${reference.provider}\u0000${reference.reference}`;

interface CachedSecret {
  // A provider whose config changed, such as another account, reads again.
  readonly config: string;
  readonly value: string | undefined;
}

const decodeConfigWith = Schema.decodeUnknownOption<Schema.Codec<unknown, unknown>>;

interface ReadablePlan {
  readonly driver: SecretProviderDriver;
  readonly config: unknown;
  readonly configKey: string;
}

export const make = Effect.fn("SecretResolver.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
  readonly secretProviders: Effect.Effect<ServerSettings["secretProviders"]>;
}) {
  const context = yield* Effect.context<SecretProviderDriverServices>();
  const driversByKind = new Map(
    options.drivers.map((driver) => [
      driver.kind,
      { driver, decodeConfig: decodeConfigWith(driver.definition.configSchema) },
    ]),
  );
  const cache = new Map<string, CachedSecret>();
  const semaphore = yield* Semaphore.make(1);

  // Only a provider this build can read is cached; anything else fails fast and is checked again
  // on the next read.
  const planFor = (
    providers: ServerSettings["secretProviders"],
    reference: SecretReference,
  ): ReadablePlan | undefined => {
    const provider = providers[reference.provider];
    const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
    if (provider === undefined || entry === undefined) return undefined;
    const { driver, decodeConfig } = entry;
    if (!driver.definition.isReference(reference.reference)) return undefined;
    const config = decodeConfig(provider.config);
    return Option.isNone(config)
      ? undefined
      : { driver, config: config.value, configKey: JSON.stringify(config.value) };
  };

  const read: SecretResolver["Service"]["read"] = Effect.fn("SecretResolver.read")(
    function* (references) {
      const providers = yield* options.secretProviders;
      const plans = references.map((reference) => planFor(providers, reference));

      const wanted = new Map<
        string,
        { readonly plan: ReadablePlan; readonly byReference: Map<string, Array<SecretReference>> }
      >();
      references.forEach((reference, index) => {
        const plan = plans[index];
        if (plan === undefined || cache.get(cacheKey(reference))?.config === plan.configKey) return;
        const group = wanted.get(reference.provider) ?? { plan, byReference: new Map() };
        group.byReference.set(reference.reference, [
          ...(group.byReference.get(reference.reference) ?? []),
          reference,
        ]);
        wanted.set(reference.provider, group);
      });
      for (const { plan, byReference } of wanted.values()) {
        const values = yield* plan.driver.read(plan.config, [...byReference.keys()]);
        [...byReference.values()].forEach((sameReference, index) => {
          for (const reference of sameReference) {
            cache.set(cacheKey(reference), { config: plan.configKey, value: values[index] });
          }
        });
      }

      return references.map((reference, index) => {
        const cached = cache.get(cacheKey(reference));
        return plans[index] !== undefined && cached?.config === plans[index].configKey
          ? cached.value
          : undefined;
      });
    },
    (effect) => semaphore.withPermits(1)(effect),
    Effect.provideContext(context),
  );

  const invalidate: SecretResolver["Service"]["invalidate"] = (references) =>
    semaphore.withPermits(1)(
      Effect.sync(() => {
        if (references === undefined) cache.clear();
        else for (const reference of references) cache.delete(cacheKey(reference));
      }),
    );

  return SecretResolver.of({ read, invalidate });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(SecretResolver, make(options));

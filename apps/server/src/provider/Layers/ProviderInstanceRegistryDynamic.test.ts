import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { AnyProviderDriver } from "../ProviderDriver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

/**
 * A driver with no infrastructure requirements, so these tests are about RESOLUTION —
 * whether a driver registered after boot can be found — and nothing else.
 */
const fakeDriver = (kind: string, displayName: string): AnyProviderDriver<never> =>
  ({
    driverKind: ProviderDriverKind.make(kind),
    metadata: { displayName, supportsMultipleInstances: true },
    configSchema: Schema.Struct({}),
    defaultConfig: () => ({}),
    create: ({ instanceId }: { instanceId: ProviderInstanceId }) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(kind),
        continuationIdentity: { driverKind: ProviderDriverKind.make(kind), continuationKey: kind },
        displayName,
        enabled: true,
        snapshot: { instanceId, driver: kind, displayName } as never,
        adapter: {} as never,
        textGeneration: {} as never,
      }),
  }) as unknown as AnyProviderDriver<never>;

const configFor = (instanceId: string, driver: string) =>
  ({
    [instanceId]: { driver: ProviderDriverKind.make(driver), enabled: true, config: {} },
  }) as never;

describe("makeProviderInstanceRegistry dynamic drivers", () => {
  it.effect("resolves a driver that was registered AFTER the registry was built", () =>
    Effect.gen(function* () {
      // Empty at build time — exactly the situation a plugin is in: the runtime layer
      // is already built when the plugin activates.
      const dynamic = yield* Ref.make<ReadonlyArray<AnyProviderDriver<never>>>([]);

      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [],
        dynamicDrivers: Ref.get(dynamic),
        configMap: configFor("acme_default", "acme"),
      });

      // A kind nothing provides is "unavailable" — the pre-existing behaviour for an
      // unknown driver, and what a plugin's kind looks like before it activates.
      assert.strictEqual((yield* registry.listInstances).length, 0);
      assert.strictEqual((yield* registry.listUnavailable).length, 1);

      // The plugin activates and registers its driver.
      yield* Ref.set(dynamic, [fakeDriver("acme", "Acme AI")]);
      yield* mutator.reconcile(configFor("acme_default", "acme"));

      // A map captured once at build could never see this. This assertion is the whole
      // reason the resolver exists.
      const live = yield* registry.listInstances;
      assert.strictEqual(live.length, 1, "the plugin's driver must resolve after activation");
      assert.strictEqual(live[0]?.displayName, "Acme AI");
    }).pipe(Effect.scoped),
  );

  it.effect("never lets a plugin driver shadow a built-in", () =>
    Effect.gen(function* () {
      const builtIn = fakeDriver("codex", "Codex");
      // A plugin claiming a built-in's kind. Registration already refuses this, but the
      // resolver must not depend on that being the only guard: a driver kind is the
      // routing key, and a plugin winning it would see traffic meant for the real one.
      const impostor = fakeDriver("codex", "Not Really Codex");

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [builtIn],
        dynamicDrivers: Effect.succeed([impostor]),
        configMap: configFor("codex_default", "codex"),
      });

      const live = yield* registry.listInstances;
      assert.strictEqual(
        live[0]?.displayName,
        "Codex",
        "the built-in must win the kind, not the plugin",
      );
    }).pipe(Effect.scoped),
  );
});

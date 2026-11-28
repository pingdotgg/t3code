import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, SecretProviderId } from "@t3tools/contracts";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

describe("provider instance rebuild", () => {
  it.effect("uses prepared credentials when teardown invalidates the resolver cache", () =>
    Effect.gen(function* () {
      const first = ProviderInstanceId.make("first");
      const second = ProviderInstanceId.make("second");
      const driverKind = ProviderDriverKind.make("fake");
      const rebuilding = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let revision = "original";
      let cacheInvalidated = false;
      const driver: AnyProviderDriver = {
        driverKind,
        metadata: { displayName: "Fake" },
        configSchema: Schema.Unknown,
        defaultConfig: () => ({}),
        create: (input) =>
          Effect.gen(function* () {
            const continuationKey = input.environment[0]?.value;
            let open = true;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                open = false;
                if (continuationKey === "original") cacheInvalidated = true;
              }),
            );
            if (input.instanceId === second && continuationKey === "rotated") {
              yield* Deferred.succeed(rebuilding, undefined);
              yield* Deferred.await(finish);
            }
            return {
              instanceId: input.instanceId,
              enabled: input.enabled,
              continuationIdentity: { driverKind, continuationKey },
              refreshModels: () => Effect.sync(() => expect(open).toBe(true)),
            } as ProviderInstance;
          }),
      };
      const entry = {
        driver: driverKind,
        config: {},
        environment: [
          {
            name: "API_KEY",
            value: { provider: SecretProviderId.make("vault"), reference: "test-key" },
            sensitive: true,
          },
        ],
      };
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: { [first]: entry, [second]: entry },
      }).pipe(
        Effect.provideService(SecretResolver.SecretResolver, {
          label: (provider) => Effect.succeed(provider),
          invalidate: () => Effect.void,
          read: (references) =>
            Effect.sync(() => references.map(() => (cacheInvalidated ? undefined : revision))),
        }),
      );
      yield* mutator.reloadSecrets();
      revision = "rotated";
      const rebuild = yield* mutator.rebuild([first, second]).pipe(Effect.forkChild);
      const started = yield* Effect.raceFirst(
        Deferred.await(rebuilding).pipe(Effect.as(true)),
        Fiber.await(rebuild).pipe(Effect.as(false)),
      );
      expect(started).toBe(true);
      yield* Fiber.interrupt(rebuild).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.await(rebuild);

      const instances = yield* registry.listInstances;
      expect(
        instances.map(({ instanceId, continuationIdentity }) => [
          instanceId,
          continuationIdentity.continuationKey,
        ]),
      ).toEqual([
        [first, "rotated"],
        [second, "rotated"],
      ]);
      for (const instance of instances) {
        expect(instance.refreshModels).toBeDefined();
        yield* instance.refreshModels?.() ?? Effect.void;
      }
    }),
  );
});

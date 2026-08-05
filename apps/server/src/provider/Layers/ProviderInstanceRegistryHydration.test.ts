import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { refreshProviderInstancesAfterEnvironmentHydration } from "./ProviderInstanceRegistryHydration.ts";

it.effect("refreshes profile-discovered tools without replacing active provider instances", () =>
  Effect.gen(function* () {
    const refreshes = yield* Ref.make<ReadonlyArray<string>>([]);
    const stopped = yield* Ref.make(0);
    const driverKind = ProviderDriverKind.make("test");
    const active = {
      instanceId: ProviderInstanceId.make("active"),
      driverKind,
      continuationIdentity: { driverKind, continuationKey: "test:active" },
      displayName: "active",
      enabled: true,
      snapshot: {
        getSnapshot: Effect.die("unused"),
        refresh: Ref.update(refreshes, (ids) => [...ids, "active"]).pipe(
          Effect.andThen(Effect.die("profile refresh failure")),
        ),
      } as unknown as ProviderInstance["snapshot"],
      adapter: {
        listSessions: () =>
          Effect.succeed([
            {
              activeTurnId: "turn-active",
            },
          ]),
        stopAll: () => Ref.update(stopped, (count) => count + 1),
      } as unknown as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    } satisfies ProviderInstance;
    const idle = {
      ...active,
      instanceId: ProviderInstanceId.make("idle"),
      displayName: "idle",
      continuationIdentity: { driverKind, continuationKey: "test:idle" },
      snapshot: {
        getSnapshot: Effect.die("unused"),
        refresh: Ref.update(refreshes, (ids) => [...ids, "idle"]).pipe(Effect.as({} as never)),
      } as unknown as ProviderInstance["snapshot"],
    } satisfies ProviderInstance;
    const instances = [active, idle] as const;
    const registry = ProviderInstanceRegistry.of({
      getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("unused"),
    });

    yield* refreshProviderInstancesAfterEnvironmentHydration(registry);

    expect(yield* registry.getInstance(active.instanceId)).toBe(active);
    expect([...(yield* Ref.get(refreshes))].toSorted()).toEqual(["active", "idle"]);
    expect(yield* Ref.get(stopped)).toBe(0);
  }),
);

it.effect("does not restore a stale instance when settings overlap profile hydration", () =>
  Effect.gen(function* () {
    const driverKind = ProviderDriverKind.make("test");
    const instanceId = ProviderInstanceId.make("test_default");
    const refreshStarted = yield* Deferred.make<void>();
    const releaseRefresh = yield* Deferred.make<void>();
    const makeInstance = (
      displayName: string,
      refresh: Effect.Effect<never>,
    ): ProviderInstance => ({
      instanceId,
      driverKind,
      continuationIdentity: { driverKind, continuationKey: `test:${displayName}` },
      displayName,
      enabled: true,
      snapshot: {
        getSnapshot: Effect.die("unused"),
        refresh,
      } as unknown as ProviderInstance["snapshot"],
      adapter: {} as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    });
    const stale = makeInstance(
      "stale",
      Deferred.succeed(refreshStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRefresh)),
        Effect.andThen(Effect.die("unused result")),
      ),
    );
    const newest = makeInstance("newest", Effect.die("must not refresh the replacement"));
    const current = yield* Ref.make(stale);
    const registry = ProviderInstanceRegistry.of({
      getInstance: () => Ref.get(current).pipe(Effect.map((instance) => instance)),
      listInstances: Ref.get(current).pipe(Effect.map((instance) => [instance])),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("unused"),
    });

    const hydration = yield* Effect.forkChild(
      refreshProviderInstancesAfterEnvironmentHydration(registry),
      { startImmediately: true },
    );
    yield* Deferred.await(refreshStarted);
    yield* Ref.set(current, newest);
    yield* Deferred.succeed(releaseRefresh, undefined);
    yield* Fiber.join(hydration);

    expect(yield* registry.getInstance(instanceId)).toBe(newest);
  }),
);

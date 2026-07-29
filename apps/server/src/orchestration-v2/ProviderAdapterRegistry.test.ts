import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "./ProviderAdapterDriver.ts";
import {
  layerFromProviderInstanceRegistry,
  makeRegistryFromConfigMap,
  ProviderAdapterRegistryV2,
} from "./ProviderAdapterRegistry.ts";

const driver = ProviderDriverKind.make("codex");
const personalId = ProviderInstanceId.make("codex_personal");
const workId = ProviderInstanceId.make("codex_work");

const makeAdapter = (instanceId: ProviderInstanceId): ProviderAdapterV2Shape =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.die("capabilities are not used by this registry test"),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by this registry test"),
  }) as ProviderAdapterV2Shape;

const makeInstance = (
  instanceId: ProviderInstanceId,
  orchestrationAdapter: ProviderAdapterV2Shape,
): ProviderInstance => ({
  instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: `codex:test:${instanceId}`,
  },
  displayName: String(instanceId),
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const personalAdapter = makeAdapter(personalId);
const workAdapter = makeAdapter(workId);
const instances = [
  makeInstance(personalId, personalAdapter),
  makeInstance(workId, workAdapter),
] as const;
const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(instances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});
const TestLayer = layerFromProviderInstanceRegistry.pipe(Layer.provide(instanceRegistryLayer));

it.effect("routes two configured instances of the same driver independently", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistryV2;

    assert.strictEqual(yield* registry.get(personalId), personalAdapter);
    assert.strictEqual(yield* registry.get(workId), workAdapter);
    assert.deepEqual(yield* registry.list(), [personalId, workId]);
  }).pipe(Effect.provide(TestLayer)),
);

const lifecycleDriver = ProviderDriverKind.make("lifecycle-test");
const lifecycleInstanceId = ProviderInstanceId.make("lifecycle-test");
const lifecycleConfigMap: ProviderInstanceConfigMap = {
  [lifecycleInstanceId]: {
    driver: lifecycleDriver,
    config: {},
  },
};
const lifecycleAdapter = makeAdapter(lifecycleInstanceId);

const makeLifecycleDriver = (
  create: Effect.Effect<ProviderAdapterV2Shape, ProviderAdapterDriverCreateError, Scope.Scope>,
): ProviderAdapterDriver<Record<string, never>> => ({
  driverKind: lifecycleDriver,
  configSchema: Schema.Struct({}),
  defaultConfig: () => ({}),
  create: () => create,
});

const trackedCreate = <A, E, R>(
  releases: Ref.Ref<number>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Ref.update(releases, (count) => count + 1));
    return yield* effect;
  });

it.effect("closes a partially-created adapter scope immediately on typed failure", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);
    const createError = new ProviderAdapterDriverCreateError({
      driver: lifecycleDriver,
      instanceId: lifecycleInstanceId,
      detail: "expected test failure",
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const exit = yield* makeRegistryFromConfigMap({
          drivers: [makeLifecycleDriver(trackedCreate(releases, Effect.fail(createError)))],
          configMap: lifecycleConfigMap,
        }).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(yield* Ref.get(releases), 1);
      }),
    );

    assert.strictEqual(yield* Ref.get(releases), 1);
  }),
);

it.effect("closes a partially-created adapter scope immediately on defect", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const exit = yield* makeRegistryFromConfigMap({
          drivers: [
            makeLifecycleDriver(trackedCreate(releases, Effect.die("expected test defect"))),
          ],
          configMap: lifecycleConfigMap,
        }).pipe(Effect.exit);

        assert.isTrue(Exit.hasDies(exit));
        assert.strictEqual(yield* Ref.get(releases), 1);
      }),
    );

    assert.strictEqual(yield* Ref.get(releases), 1);
  }),
);

it.effect("closes a partially-created adapter scope immediately on interruption", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);
    const createStarted = yield* Deferred.make<void>();

    yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* makeRegistryFromConfigMap({
          drivers: [
            makeLifecycleDriver(
              trackedCreate(
                releases,
                Deferred.succeed(createStarted, undefined).pipe(Effect.andThen(Effect.never)),
              ),
            ),
          ],
          configMap: lifecycleConfigMap,
        }).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(createStarted);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);

        assert.isTrue(Exit.hasInterrupts(exit));
        assert.strictEqual(yield* Ref.get(releases), 1);
      }),
    );

    assert.strictEqual(yield* Ref.get(releases), 1);
  }),
);

it.effect("keeps a successfully-created adapter scope open until normal release", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistryFromConfigMap({
          drivers: [makeLifecycleDriver(trackedCreate(releases, Effect.succeed(lifecycleAdapter)))],
          configMap: lifecycleConfigMap,
        });

        assert.strictEqual(yield* registry.get(lifecycleInstanceId), lifecycleAdapter);
        assert.strictEqual(yield* Ref.get(releases), 0);
      }),
    );

    assert.strictEqual(yield* Ref.get(releases), 1);
  }),
);

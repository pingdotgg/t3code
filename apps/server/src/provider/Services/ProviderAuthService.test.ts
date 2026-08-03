import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderSignInEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import type { ProviderAuthOps } from "../ProviderAuthOps.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderAuthService } from "./ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex");
const OTHER_INSTANCE_ID = ProviderInstanceId.make("codex-work");

interface Harness {
  readonly refreshed: Ref.Ref<ReadonlyArray<ProviderInstanceId>>;
  readonly signedOut: Ref.Ref<number>;
}

function makeInstance(auth: ProviderAuthOps | undefined): ProviderInstance {
  return {
    instanceId: INSTANCE_ID,
    driverKind: "codex",
    continuationIdentity: { driverKind: "codex", continuationKey: "codex:test" },
    displayName: undefined,
    enabled: true,
    snapshot: undefined,
    adapter: undefined,
    textGeneration: undefined,
    ...(auth === undefined ? {} : { auth }),
  } as unknown as ProviderInstance;
}

function makeAuthOps(
  harness: Harness,
  events: ReadonlyArray<ProviderSignInEvent>,
): ProviderAuthOps {
  return {
    authMethods: ["browser", "deviceCode"],
    startSignIn: () => Stream.fromArray([...events]),
    signOut: Ref.update(harness.signedOut, (count) => count + 1),
  };
}

function makeLayer(input: {
  readonly harness: Harness;
  readonly instance: ProviderInstance | undefined;
}) {
  const instanceRegistry = Layer.mock(ProviderInstanceRegistry)({
    getInstance: (instanceId) =>
      Effect.succeed(
        input.instance !== undefined && instanceId === INSTANCE_ID ? input.instance : undefined,
      ),
    listInstances: Effect.succeed([]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
  });
  const registry = Layer.mock(ProviderRegistry)({
    getProviders: Effect.succeed<ReadonlyArray<ServerProvider>>([]),
    refresh: () => Effect.succeed([]),
    refreshInstance: (instanceId) =>
      Ref.update(input.harness.refreshed, (seen) => [...seen, instanceId]).pipe(
        Effect.as<ReadonlyArray<ServerProvider>>([]),
      ),
    setProviderMaintenanceActionState: () => Effect.succeed([]),
    streamChanges: Stream.empty,
  });

  return ProviderAuthService.layer.pipe(Layer.provide(Layer.mergeAll(instanceRegistry, registry)));
}

const makeHarness = Effect.gen(function* () {
  return {
    refreshed: yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]),
    signedOut: yield* Ref.make(0),
  } satisfies Harness;
});

describe("ProviderAuthService.startSignIn", () => {
  it.effect("refreshes the instance exactly once on a completed login", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const layer = makeLayer({
        harness,
        instance: makeInstance(
          makeAuthOps(harness, [
            { _tag: "started" },
            { _tag: "deviceCode", userCode: "ABCD-EFGHI", verificationUrl: "https://v" },
            { _tag: "completed" },
          ]),
        ),
      });

      const events = yield* Effect.gen(function* () {
        const service = yield* ProviderAuthService;
        return yield* Stream.runCollect(
          service.startSignIn({ instanceId: INSTANCE_ID, mode: "deviceCode" }),
        );
      }).pipe(Effect.provide(layer));

      NodeAssert.equal(events.length, 3);
      // The empty-model-catalog regression: without this refresh the user
      // signs in successfully and still sees no models.
      NodeAssert.deepStrictEqual(yield* Ref.get(harness.refreshed), [INSTANCE_ID]);
    }),
  );

  it.effect("does not refresh when the login failed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const layer = makeLayer({
        harness,
        instance: makeInstance(
          makeAuthOps(harness, [{ _tag: "started" }, { _tag: "failed", message: "nope" }]),
        ),
      });

      yield* Effect.gen(function* () {
        const service = yield* ProviderAuthService;
        return yield* Stream.runDrain(
          service.startSignIn({ instanceId: INSTANCE_ID, mode: "browser" }),
        );
      }).pipe(Effect.provide(layer));

      NodeAssert.deepStrictEqual(yield* Ref.get(harness.refreshed), []);
    }),
  );

  it.effect("fails with ProviderAuthUnsupportedError for an unknown instance", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const layer = makeLayer({ harness, instance: undefined });

      const error = yield* Effect.gen(function* () {
        const service = yield* ProviderAuthService;
        return yield* Stream.runDrain(
          service.startSignIn({ instanceId: OTHER_INSTANCE_ID, mode: "browser" }),
        );
      }).pipe(Effect.provide(layer), Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAuthUnsupportedError");
      NodeAssert.match(error.reason, /no such provider instance/);
    }),
  );

  it.effect("fails with ProviderAuthUnsupportedError for a driver with no account support", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const layer = makeLayer({ harness, instance: makeInstance(undefined) });

      const error = yield* Effect.gen(function* () {
        const service = yield* ProviderAuthService;
        return yield* Stream.runDrain(
          service.startSignIn({ instanceId: INSTANCE_ID, mode: "browser" }),
        );
      }).pipe(Effect.provide(layer), Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAuthUnsupportedError");
      NodeAssert.match(error.reason, /no in-app account support/);
    }),
  );
});

describe("ProviderAuthService.signOut", () => {
  it.effect("signs out through the driver and refreshes the snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const layer = makeLayer({ harness, instance: makeInstance(makeAuthOps(harness, [])) });

      yield* Effect.gen(function* () {
        const service = yield* ProviderAuthService;
        return yield* service.signOut({ instanceId: INSTANCE_ID });
      }).pipe(Effect.provide(layer));

      NodeAssert.equal(yield* Ref.get(harness.signedOut), 1);
      NodeAssert.deepStrictEqual(yield* Ref.get(harness.refreshed), [INSTANCE_ID]);
    }),
  );

  it.effect("refuses to sign out an instance whose driver has no account support", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const layer = makeLayer({ harness, instance: makeInstance(undefined) });

      const error = yield* Effect.gen(function* () {
        const service = yield* ProviderAuthService;
        return yield* service.signOut({ instanceId: INSTANCE_ID });
      }).pipe(Effect.provide(layer), Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAuthUnsupportedError");
      NodeAssert.equal(yield* Ref.get(harness.signedOut), 0);
      NodeAssert.deepStrictEqual(yield* Ref.get(harness.refreshed), []);
    }),
  );
});

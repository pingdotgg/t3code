import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PiDriver } from "./PiDriver.ts";

const assert: typeof NodeAssert = NodeAssert;
const backgroundPolicyLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  shouldRunScopeWork: () => Effect.succeed(true),
});
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pi-driver-test-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(backgroundPolicyLayer),
);

it("registers Pi as a built-in driver", () => {
  assert.equal(
    BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "pi"),
    PiDriver,
  );
});

it.layer(testLayer)("PiDriver", (it) => {
  it.effect("creates the disabled adapter, snapshot, and text-generation bundle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("pi-work");
        const instance = yield* PiDriver.create({
          instanceId,
          displayName: "Pi Work",
          enabled: false,
          environment: [{ name: "PI_HOME", value: "/tmp/pi-home", sensitive: false }],
          config: PiDriver.defaultConfig(),
        });
        const snapshot = yield* instance.snapshot.getSnapshot;

        assert.equal(instance.instanceId, instanceId);
        assert.equal(instance.driverKind, "pi");
        assert.equal(typeof instance.adapter.startSession, "function");
        assert.equal(typeof instance.textGeneration.generateCommitMessage, "function");
        assert.equal(snapshot.enabled, false);
        assert.equal(snapshot.instanceId, instanceId);
        assert.equal(snapshot.driver, "pi");
      }),
    ),
  );
});

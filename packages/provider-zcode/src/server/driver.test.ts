import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import { ZCodeDriver } from "./driver.ts";

const layerTest = layerTestProviderHost({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled ZCode must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled ZCode must not spawn a process"),
);

it.layer(layerTest)("ZCodeDriver", (it) => {
  it.effect("reports a disabled instance without starting the bridge", () =>
    Effect.gen(function* () {
      const instance = yield* ZCodeDriver.create({
        instanceId: ProviderInstanceId.make("zcode-disabled"),
        displayName: "ZCode test",
        enabled: false,
        environment: [],
        config: ZCodeDriver.defaultConfig(),
      });

      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot).toMatchObject({
        driver: "zcode",
        enabled: false,
        supportsTextGeneration: false,
        message: "ZCode is disabled in T3 Code settings.",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["zcode-default"]);
      expect(snapshot.supportedRuntimeModes).toEqual([
        "approval-required",
        "auto-accept-edits",
        "full-access",
      ]);
      // The bridge is a separate npm install T3 does not own.
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});

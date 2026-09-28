import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { DshDriver } from "./DshDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-dsh-driver-update-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled DSH must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled DSH must not spawn a process"),
);

it("exposes the dsh driver kind and display name", () => {
  expect(DshDriver.driverKind).toBe(ProviderDriverKind.make("dsh"));
  expect(DshDriver.metadata).toEqual({
    displayName: "DSH",
    supportsMultipleInstances: true,
  });
  const defaults = DshDriver.defaultConfig();
  expect(defaults.enabled).toBe(false);
  expect(defaults.binaryPath).toBe("dsh");
  expect(defaults.customModels).toEqual([]);
});

it.layer(testLayer)("DshDriver", (it) => {
  // DSH has no self-updater; maintenance is manual through the npm package.
  it.effect("stays manual-only for an instance with a missing executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-missing-" });
      const instance = yield* DshDriver.create({
        instanceId: ProviderInstanceId.make("dsh-missing"),
        displayName: "DSH test",
        enabled: false,
        environment: [],
        config: { ...DshDriver.defaultConfig(), binaryPath: path.join(tempDir, "dsh") },
      });
      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("@deepseek-ai/dsh");
      expect(capabilities.update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});

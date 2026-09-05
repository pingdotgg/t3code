import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CursorDriver } from "./CursorDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cursor-driver-copy-command-",
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
      HttpClient.make(() => Effect.die("Disabled Cursor must not make an HTTP request")),
    ),
  ),
);

it.layer(testLayer)("CursorDriver", (it) => {
  it.effect("formats a copied update command for the injected Windows environment", () =>
    Effect.gen(function* () {
      const binaryPath = "C:\\Users\\Example User\\.local\\bin\\cursor-agent.exe";
      const instance = yield* CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor-copy-command"),
        displayName: "Cursor test",
        enabled: false,
        environment: [],
        config: { ...CursorDriver.defaultConfig(), binaryPath },
      });

      expect(instance.snapshot.maintenanceCapabilities.update).toMatchObject({
        command: `& '${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      expect((yield* instance.snapshot.refresh).status).toBe("disabled");
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Disabled Cursor must not spawn a process")),
      ),
      Effect.scoped,
    ),
  );
});

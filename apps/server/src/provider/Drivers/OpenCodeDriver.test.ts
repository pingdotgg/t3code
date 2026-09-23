import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { OpenCodeDriver } from "./OpenCodeDriver.ts";

const SERVER_URL = "http://127.0.0.1:4301";

const hangingCommandsRuntime: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("unused"),
  connectToOpenCodeServer: () =>
    Effect.succeed({ url: SERVER_URL, version: "1.18.32", exitCode: null, external: true }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode 1.18.32\n", stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({ command: { list: () => new Promise(() => {}) } }) as unknown as ReturnType<
      OpenCodeRuntimeShape["createOpenCodeSdkClient"]
    >,
  loadOpenCodeInventory: () =>
    Effect.succeed({
      providerList: { connected: [], all: [], default: {} },
      agents: [],
      skills: [],
    }),
  loadInventoryFromCli: () => Effect.die("unused"),
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadSkillsFromCli: () => Effect.succeed([]),
};

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opencode-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest({ enableProviderUpdateChecks: false })),
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, hangingCommandsRuntime)),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
      ),
    ),
  ),
);

it.layer(testLayer)("OpenCodeDriver", (it) => {
  it.effect("fails a workspace probe whose command list times out", () =>
    Effect.gen(function* () {
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-slow-commands"),
        displayName: "OpenCode test",
        enabled: true,
        environment: [],
        config: { ...OpenCodeDriver.defaultConfig(), serverUrl: SERVER_URL },
      });

      const probe = yield* Effect.forkChild(Effect.flip(instance.snapshotForCwd!(process.cwd())));
      yield* TestClock.adjust("10 seconds");

      expect((yield* Fiber.join(probe)).detail).toContain("Failed to probe OpenCode commands");
    }).pipe(Effect.scoped),
  );
});

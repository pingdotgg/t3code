// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CursorDriver } from "./CursorDriver.ts";
import { CursorAgentSdkRunner } from "../../orchestration-v2/Adapters/CursorAgentSdk.ts";
import { layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cursor-driver-copy-command-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(idAllocatorLayer),
  Layer.provideMerge(
    Layer.mock(CursorAgentSdkRunner)({
      open: () => Effect.die("Maintenance resolution must not open a Cursor session"),
    }),
  ),
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
  it.effect("keeps the bundled SDK manual-only without probing or updating cursor-agent", () =>
    Effect.gen(function* () {
      const instance = yield* CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor-sdk"),
        displayName: "Cursor test",
        enabled: false,
        environment: [],
        config: CursorDriver.defaultConfig(),
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      expect((yield* instance.snapshot.refresh).status).toBe("disabled");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("SDK maintenance must not spawn a process")),
      ),
      Effect.scoped,
    ),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - Entry point for the inherited-pipe shutdown regression test.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../../serverSettings.ts";

import * as ServerConfig from "../../config.ts";
import * as DesktopTelemetryReceiver from "../../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopBrowserChannel from "../DesktopBrowserChannel.ts";

const key = { threadId: "thread-1", tabId: "tab-1" };

Effect.gen(function* () {
  const base = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pipe-lifecycle-" })),
  );
  const context = yield* Layer.build(
    Layer.merge(DesktopBrowserChannel.layer, DesktopTelemetryReceiver.layer).pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, {
          ...base,
          desktopBrowserFd: 3,
          desktopBrowserControlFd: 4,
          desktopTelemetryFd: 5,
          desktopTelemetryControlFd: 6,
        }),
      ),
    ),
  );
  const browser = Context.get(context, DesktopBrowserChannel.DesktopBrowserChannel);
  const telemetry = Context.get(context, DesktopTelemetryReceiver.DesktopTelemetryReceiver);
  const health = yield* telemetry.subscribeHealth;
  const healthy = yield* health.changes.pipe(
    Stream.filter((value) => value.status === "healthy"),
    Stream.runHead,
    Effect.forkScoped,
  );
  const detached = yield* browser.detached.pipe(Stream.runHead, Effect.forkScoped);
  yield* Console.log("ready");
  if (!(yield* browser.awaitAttached(key, "5 seconds"))) {
    return yield* Effect.die("The browser attach message was not received.");
  }
  yield* Fiber.join(healthy);
  yield* Console.log("attached");
  yield* Fiber.join(detached);
  const endpoint = yield* Effect.exit(Effect.scoped(browser.endpoint(key)));
  if (Exit.isSuccess(endpoint)) return yield* Effect.die("A detached tab received an endpoint.");
  yield* Console.log("verified");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);

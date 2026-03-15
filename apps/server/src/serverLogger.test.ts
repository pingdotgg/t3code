import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, LogLevel, Path, References } from "effect";

import { ServerConfig } from "./config.ts";
import { ServerLoggerLive } from "./serverLogger.ts";

it.layer(NodeServices.layer)("ServerLoggerLive", (it) => {
  it.effect("provides the configured minimum log level and initializes log storage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-logger-",
      });
      const configLayer = Layer.succeed(ServerConfig, {
        logLevel: "Warn",
        mode: "web",
        port: 0,
        host: undefined,
        cwd: process.cwd(),
        keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
        stateDir,
        staticDir: undefined,
        devUrl: undefined,
        noBrowser: true,
        authToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
      });

      const result = yield* Effect.gen(function* () {
        return {
          minimumLogLevel: yield* References.MinimumLogLevel,
          debugEnabled: yield* LogLevel.isEnabled("Debug"),
          warnEnabled: yield* LogLevel.isEnabled("Warn"),
          logDirExists: yield* fileSystem.exists(path.join(stateDir, "logs")),
        };
      }).pipe(Effect.provide(ServerLoggerLive.pipe(Layer.provide(configLayer))));

      assert.equal(result.minimumLogLevel, "Warn");
      assert.isFalse(result.debugEnabled);
      assert.isTrue(result.warnEnabled);
      assert.isTrue(result.logDirExists);
    }),
  );
});

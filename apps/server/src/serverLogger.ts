import fs from "node:fs";
import path from "node:path";

import { Effect, Logger, References } from "effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config";

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;

  const logDir = path.join(config.stateDir, "logs");
  const logPath = path.join(logDir, "server.log");

  yield* Effect.sync(() => {
    fs.mkdirSync(logDir, { recursive: true });
  });

  const fileLogger = Logger.formatSimple.pipe(Logger.toFile(logPath));
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggerLayer = Logger.layer([Logger.consolePretty(), fileLogger], {
    mergeWithExisting: false,
  });

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);

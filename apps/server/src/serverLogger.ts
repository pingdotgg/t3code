import fs from "node:fs";
import path from "node:path";

import { Effect, Logger } from "effect";
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

  return Logger.layer([Logger.defaultLogger, fileLogger], {
    mergeWithExisting: false,
  });
}).pipe(Layer.unwrap);

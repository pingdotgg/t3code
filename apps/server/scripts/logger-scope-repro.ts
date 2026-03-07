import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import path from "node:path";

import { Effect, FileSystem, Layer, Logger, ServiceMap } from "effect";

import { makeEventNdjsonLogger } from "../src/provider/Layers/EventNdjsonLogger.ts";

class LogDir extends ServiceMap.Service<LogDir, string>()("t3/scripts/logger-scope-repro/LogDir") {}

const main = Effect.gen(function* () {
  const logdir = yield* LogDir;
  const providerLogPath = path.join(logdir, "provider");

  yield* Effect.logInfo(`providerLogPath=${providerLogPath}`);

  const providerLogger = yield* makeEventNdjsonLogger(providerLogPath, {
    stream: "native",
    batchWindowMs: 10,
  });

  yield* Effect.logInfo("before provider write");

  if (providerLogger) {
    yield* providerLogger.write(
      {
        kind: "probe",
        message: "provider-only event",
      },
      "thread-123" as never,
    );
  }

  yield* Effect.logInfo("after provider write");
  yield* Effect.sleep("50 millis");

  if (providerLogger) {
    yield* providerLogger.close();
  }
  yield* Effect.logInfo("after provider close");

  const fs = yield* FileSystem.FileSystem;
  const logContents = yield* fs
    .readDirectory(logdir, { recursive: true })
    .pipe(
      Effect.flatMap((entries) =>
        Effect.all(entries.map((entry) => fs.readFileString(path.join(logdir, entry)))),
      ),
    );
  yield* Effect.logInfo(`logContents=${logContents}`);
});

Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const logdir = path.join(process.cwd(), "logtest");
  yield* fs.makeDirectory(logdir);

  const fileLogger = yield* Logger.formatSimple.pipe(
    Logger.toFile(path.join(logdir, "global.log")),
  );
  const dualLogger = Logger.layer([fileLogger, Logger.consolePretty()]);

  const mainLayer = Layer.mergeAll(dualLogger, Layer.succeed(LogDir, logdir));

  yield* main.pipe(Effect.provide(mainLayer));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as DesktopBackendOutputLog from "./DesktopBackendOutputLog.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const LOG_FILE_PATH = "/Users/alice/.t3/userdata/logs/server-child.log";

const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
}).pipe(Layer.provide(Layer.merge(Path.layer, DesktopConfig.layerTest({}))));

const withOutputLog = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopBackendOutputLog.DesktopBackendOutputLog>,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem>,
  messages: Array<ReadonlyArray<unknown>>,
) => {
  const logger = Logger.make(({ message }) => {
    messages.push(Array.isArray(message) ? message : [message]);
  });
  const outputLogLayer = DesktopBackendOutputLog.layer.pipe(
    Layer.provide(Layer.mergeAll(fileSystemLayer, Path.layer, environmentLayer)),
    Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
  );
  return effect.pipe(Effect.provide(outputLogLayer));
};

const loggedError = (messages: ReadonlyArray<ReadonlyArray<unknown>>): unknown =>
  messages.flat().find((value) => typeof value === "object" && value !== null && "error" in value)
    ?.error;

describe("DesktopBackendOutputLog", () => {
  it.effect("logs setup failures with the log path and exact cause", () => {
    const messages: Array<ReadonlyArray<unknown>> = [];
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "makeDirectory",
      pathOrDescriptor: "/Users/alice/.t3/userdata/logs",
      description: "private setup diagnostic",
    });
    const fileSystemLayer = FileSystem.layerNoop({
      makeDirectory: () => Effect.fail(cause),
    });

    return withOutputLog(
      Effect.gen(function* () {
        const outputLog = yield* DesktopBackendOutputLog.DesktopBackendOutputLog;
        yield* outputLog.writeSessionBoundary({ phase: "START", details: "test" });

        const error = loggedError(messages);
        assert.instanceOf(error, DesktopBackendOutputLog.DesktopBackendOutputLogSetupError);
        assert.equal(error.logFilePath, LOG_FILE_PATH);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          `Failed to initialize the desktop backend output log at ${LOG_FILE_PATH}.`,
        );
        assert.notInclude(error.message, "private setup diagnostic");
      }),
      fileSystemLayer,
      messages,
    );
  });

  it.effect("logs record write failures with the operation and exact cause", () => {
    const messages: Array<ReadonlyArray<unknown>> = [];
    const missingCause = PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "stat",
      pathOrDescriptor: LOG_FILE_PATH,
    });
    const writeCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "writeFile",
      pathOrDescriptor: LOG_FILE_PATH,
      description: "private write diagnostic",
    });
    const fileSystemLayer = FileSystem.layerNoop({
      makeDirectory: () => Effect.void,
      stat: () => Effect.fail(missingCause),
      readDirectory: () => Effect.succeed([]),
      writeFile: () => Effect.fail(writeCause),
    });

    return withOutputLog(
      Effect.gen(function* () {
        const outputLog = yield* DesktopBackendOutputLog.DesktopBackendOutputLog;
        yield* outputLog.writeSessionBoundary({ phase: "START", details: "test" });

        const error = loggedError(messages);
        assert.instanceOf(error, DesktopBackendOutputLog.DesktopBackendOutputLogWriteError);
        assert.equal(error.operation, "write-record");
        assert.equal(error.logFilePath, LOG_FILE_PATH);
        assert.strictEqual(error.cause, writeCause);
        assert.equal(
          error.message,
          `Desktop backend output log operation "write-record" failed at ${LOG_FILE_PATH}.`,
        );
        assert.notInclude(error.message, "private write diagnostic");
      }),
      fileSystemLayer,
      messages,
    );
  });
});

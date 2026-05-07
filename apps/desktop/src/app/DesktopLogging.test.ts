import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  DesktopBackendOutputLog,
  DesktopBackendOutputLogLive,
  DesktopLoggerLive,
} from "./DesktopLogging.ts";

const environmentInput = (baseDir: string) =>
  ({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: false,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }) satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (baseDir: string) =>
  DesktopEnvironment.layer(environmentInput(baseDir)).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
        }),
      ),
    ),
  );

describe("DesktopLogging", () => {
  it.effect("persists desktop main logs in development", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-logging-test-",
      });
      const environmentLayer = makeEnvironmentLayer(baseDir);
      const logPath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "desktop-main.log");
      }).pipe(Effect.provide(environmentLayer));

      yield* Effect.scoped(
        Effect.logInfo("desktop file logger test").pipe(
          Effect.annotateLogs({ testCase: "desktop-main-dev" }),
          Effect.provide(DesktopLoggerLive.pipe(Layer.provideMerge(environmentLayer))),
        ),
      );

      const log = yield* fileSystem.readFileString(logPath);
      assert.include(log, "desktop file logger test");
      assert.include(log, "desktop-main-dev");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("persists backend child session boundaries in development", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-output-log-test-",
      });
      const environmentLayer = makeEnvironmentLayer(baseDir);
      const logPath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "server-child.log");
      }).pipe(Effect.provide(environmentLayer));

      yield* Effect.gen(function* () {
        const outputLog = yield* DesktopBackendOutputLog;
        yield* outputLog.writeSessionBoundary({
          phase: "START",
          details: "pid=123 port=3773 cwd=/repo",
        });
      }).pipe(
        Effect.annotateLogs({ runId: "test-run" }),
        Effect.provide(DesktopBackendOutputLogLive.pipe(Layer.provideMerge(environmentLayer))),
      );

      const log = yield* fileSystem.readFileString(logPath);
      assert.include(log, "APP SESSION START");
      assert.include(log, "run=test-run");
      assert.include(log, "pid=123 port=3773 cwd=/repo");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

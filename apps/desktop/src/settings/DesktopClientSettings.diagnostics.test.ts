import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

interface LogRecord {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const baseDir = "/virtual-home";

function makeLayer(fileSystemLayer: Layer.Layer<FileSystem.FileSystem>) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  return DesktopClientSettings.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(environmentLayer, NodeServices.layer, fileSystemLayer)),
  );
}

const readWithLogs = (fileSystemLayer: Layer.Layer<FileSystem.FileSystem>) => {
  const records: Array<LogRecord> = [];
  const logger = Logger.make(({ fiber, message }) => {
    records.push({
      message,
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
    });
  });

  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    return {
      result: yield* settings.get,
      settingsPath: environment.clientSettingsPath,
      records,
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeLayer(fileSystemLayer),
        Logger.layer([logger], { mergeWithExisting: false }),
      ),
    ),
  );
};

describe("DesktopClientSettings diagnostics", () => {
  it.effect("treats a missing settings file as expected without warning", () =>
    Effect.gen(function* () {
      const result = yield* readWithLogs(FileSystem.layerNoop({}));

      assert.isTrue(Option.isNone(result.result));
      assert.deepEqual(result.records, []);
    }),
  );

  it.effect("logs non-missing filesystem failures with the settings path", () => {
    const permissionError = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: `${baseDir}/userdata/client-settings.json`,
    });

    return Effect.gen(function* () {
      const result = yield* readWithLogs(
        FileSystem.layerNoop({
          readFileString: () => Effect.fail(permissionError),
        }),
      );

      assert.isTrue(Option.isNone(result.result));
      assert.equal(result.records.length, 1);
      assert.deepEqual(result.records[0]?.message, [
        "Could not read desktop client settings.",
        permissionError,
      ]);
      assert.equal(result.records[0]?.annotations.settingsPath, result.settingsPath);
    });
  });

  it.effect("logs malformed settings documents with the settings path", () =>
    Effect.gen(function* () {
      const result = yield* readWithLogs(
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed("{not-json"),
        }),
      );

      assert.isTrue(Option.isNone(result.result));
      assert.equal(result.records.length, 1);
      const message = result.records[0]?.message;
      if (!Array.isArray(message)) {
        return assert.fail("expected structured warning arguments");
      }
      assert.equal(message[0], "Could not decode desktop client settings.");
      const schemaError = message[1];
      if (schemaError === null || typeof schemaError !== "object") {
        return assert.fail("expected the schema error in the warning");
      }
      assert.equal("_tag" in schemaError ? schemaError._tag : undefined, "SchemaError");
      assert.equal(result.records[0]?.annotations.settingsPath, result.settingsPath);
    }),
  );
});

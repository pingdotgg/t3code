import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

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

const readResult = (fileSystemLayer: Layer.Layer<FileSystem.FileSystem>) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    return {
      result: yield* Effect.result(settings.get),
      settingsPath: environment.clientSettingsPath,
    };
  }).pipe(Effect.provide(makeLayer(fileSystemLayer)));

describe("DesktopClientSettings diagnostics", () => {
  it.effect("treats a missing settings file as expected", () =>
    Effect.gen(function* () {
      const result = yield* readResult(FileSystem.layerNoop({}));

      assert.equal(result.result._tag, "Success");
      if (result.result._tag === "Success") {
        assert.isTrue(Option.isNone(result.result.success));
      }
    }),
  );

  it.effect("fails non-missing filesystem reads with the settings path", () => {
    const permissionError = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: `${baseDir}/userdata/client-settings.json`,
    });

    return Effect.gen(function* () {
      const result = yield* readResult(
        FileSystem.layerNoop({
          readFileString: () => Effect.fail(permissionError),
        }),
      );

      assert.equal(result.result._tag, "Failure");
      if (result.result._tag === "Failure") {
        assert.instanceOf(
          result.result.failure,
          DesktopClientSettings.DesktopClientSettingsReadError,
        );
        assert.equal(result.result.failure.operation, "read-settings-file");
        assert.equal(result.result.failure.path, result.settingsPath);
        assert.equal(result.result.failure.cause, permissionError);
      }
    });
  });

  it.effect("fails malformed settings documents with the settings path", () =>
    Effect.gen(function* () {
      const result = yield* readResult(
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed("{not-json"),
        }),
      );

      assert.equal(result.result._tag, "Failure");
      if (result.result._tag === "Failure") {
        assert.instanceOf(
          result.result.failure,
          DesktopClientSettings.DesktopClientSettingsReadError,
        );
        assert.equal(result.result.failure.operation, "decode-document");
        assert.equal(result.result.failure.path, result.settingsPath);
        const schemaError = result.result.failure.cause;
        if (schemaError === null || typeof schemaError !== "object") {
          return assert.fail("expected the schema error as the failure cause");
        }
        assert.equal("_tag" in schemaError ? schemaError._tag : undefined, "SchemaError");
      }
    }),
  );
});

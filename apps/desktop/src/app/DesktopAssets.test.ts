import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "x64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: true,
  resourcesPath: "/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

function flattenedLogText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return String(value);
  return Object.entries(value)
    .flatMap(([key, nested]) => [key, flattenedLogText(nested)])
    .join("\n");
}

describe("DesktopAssets", () => {
  it.effect("continues resource lookup and reports failed existence probes", () => {
    const firstCandidate = "/repo/apps/desktop/resources/icon.ico";
    const fallbackCandidate = "/repo/apps/desktop/prod-resources/icon.ico";
    const probeError = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists",
      pathOrDescriptor: firstCandidate,
    });
    const capturedLogs: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make(({ message }) => {
      capturedLogs.push(Array.isArray(message) ? message : [message]);
    });
    const fileSystemLayer = FileSystem.layerNoop({
      exists: (path) => {
        if (path === firstCandidate) return Effect.fail(probeError);
        return Effect.succeed(path === fallbackCandidate);
      },
    });
    const environmentLayer = DesktopEnvironment.layer(environmentInput).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
    );
    const assetsLayer = DesktopAssets.layer.pipe(
      Layer.provideMerge(fileSystemLayer),
      Layer.provideMerge(environmentLayer),
      Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );

    return Effect.gen(function* () {
      const assets = yield* DesktopAssets.DesktopAssets;
      const iconPaths = yield* assets.iconPaths;

      assert.deepEqual(iconPaths.ico, Option.some(fallbackCandidate));
      const logText = flattenedLogText(capturedLogs);
      assert.include(logText, "desktop.assets.resourceProbe.failed");
      assert.include(logText, firstCandidate);
      assert.include(logText, "PermissionDenied");
    }).pipe(Effect.provide(assetsLayer));
  });
});

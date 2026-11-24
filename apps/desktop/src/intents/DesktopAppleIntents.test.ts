import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppleIntents from "./DesktopAppleIntents.ts";

function makeLayer(platform: NodeJS.Platform, dylibExists: boolean) {
  return DesktopAppleIntents.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform,
          isPackaged: true,
          processArch: "arm64",
          resourcesPath: "/app/Resources",
          rootDir: "/repo",
          path: { join: (...parts: string[]) => parts.join("/") },
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        FileSystem.layerNoop({
          exists: () => Effect.succeed(dylibExists),
        }),
      ),
    ),
  );
}

describe("DesktopAppleIntents", () => {
  it.effect("reports unsupported-platform on non-macOS hosts and no-ops mutations", () =>
    Effect.gen(function* () {
      const intents = yield* DesktopAppleIntents.DesktopAppleIntents;
      assert.deepEqual(yield* intents.getStatus, {
        available: false,
        reason: "unsupported-platform",
      });
      yield* intents.syncIndex({
        environments: [],
        removedEnvironmentIds: [],
        upsertedProjects: [],
        removedProjectIds: [],
        upsertedThreads: [],
        removedThreadIds: [],
      });
      yield* intents.removeEnvironment(EnvironmentId.make("env-1"));
      yield* intents.clearIndex;
      yield* intents.setOnscreenContext(null);
      yield* intents.syncAuthCredentials([]);
      assert.isNull(yield* intents.resolveSpotlightUrl("env-1:thread-1"));
    }).pipe(Effect.provide(makeLayer("linux", false))),
  );

  it.effect("reports native-bridge-unavailable on macOS when host dylib is missing", () =>
    Effect.gen(function* () {
      const intents = yield* DesktopAppleIntents.DesktopAppleIntents;
      assert.deepEqual(yield* intents.getStatus, {
        available: false,
        reason: "native-bridge-unavailable",
      });
      assert.isNull(yield* intents.resolveSpotlightUrl("env-1:thread-1"));
    }).pipe(Effect.provide(makeLayer("darwin", false))),
  );
});

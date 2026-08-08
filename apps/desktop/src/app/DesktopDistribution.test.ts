import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopDistribution from "./DesktopDistribution.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("DesktopDistribution", () => {
  it.effect("reads the isolated 2code distribution and runtime versions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appPath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-distribution-",
      });
      yield* fileSystem.writeFileString(
        path.join(appPath, "package.json"),
        encodeJson({
          t3codeDistribution: "2code-production",
          t3codeRuntimeVersion: "0.0.32",
        }),
      );

      const result = yield* DesktopDistribution.resolveDesktopDistribution({
        appPath,
        appVersion: "1.0.108",
        isPackaged: true,
      });

      assert.deepEqual(result, {
        id: "2code-production",
        runtimeVersion: "0.0.32",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not inspect package metadata in development", () =>
    Effect.gen(function* () {
      const result = yield* DesktopDistribution.resolveDesktopDistribution({
        appPath: "/missing/app",
        appVersion: "0.0.32",
        isPackaged: false,
      });

      assert.deepEqual(result, { id: "default", runtimeVersion: "0.0.32" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses default identity for a packaged app without fork metadata", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appPath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-distribution-default-",
      });
      yield* fileSystem.writeFileString(path.join(appPath, "package.json"), "{}");

      const result = yield* DesktopDistribution.resolveDesktopDistribution({
        appPath,
        appVersion: "0.0.32",
        isPackaged: true,
      });

      assert.deepEqual(result, { id: "default", runtimeVersion: "0.0.32" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when packaged distribution metadata is missing or malformed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appPath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-distribution-invalid-",
      });

      const missing = yield* DesktopDistribution.resolveDesktopDistribution({
        appPath,
        appVersion: "1.0.108",
        isPackaged: true,
      }).pipe(Effect.flip);
      assert.equal(missing.operation, "read");

      yield* fileSystem.writeFileString(path.join(appPath, "package.json"), "{broken");
      const malformed = yield* DesktopDistribution.resolveDesktopDistribution({
        appPath,
        appVersion: "1.0.108",
        isPackaged: true,
      }).pipe(Effect.flip);
      assert.equal(malformed.operation, "decode");

      yield* fileSystem.writeFileString(
        path.join(appPath, "package.json"),
        encodeJson({ t3codeDistribution: "2code-production" }),
      );
      const incomplete = yield* DesktopDistribution.resolveDesktopDistribution({
        appPath,
        appVersion: "1.0.108",
        isPackaged: true,
      }).pipe(Effect.flip);
      assert.equal(incomplete.operation, "decode");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

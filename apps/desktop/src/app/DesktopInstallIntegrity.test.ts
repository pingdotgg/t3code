import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopInstallIntegrity from "./DesktopInstallIntegrity.ts";

const makeEnvironmentLayer = (input: {
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
}) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: input.homeDirectory,
    platform: input.platform ?? "win32",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: input.isPackaged,
    resourcesPath: input.resourcesPath,
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: input.homeDirectory,
        }),
      ),
    ),
  );

const withInstallDir = <A, E, R>(
  build: (input: {
    readonly resourcesPath: string;
    readonly manifestPath: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-install-integrity-test-",
    });
    const resourcesPath = path.join(baseDir, "resources");
    const manifestPath = path.join(
      resourcesPath,
      ...DesktopInstallIntegrity.DESKTOP_BUILD_MANIFEST_RELATIVE_PATH.split("/"),
    );
    yield* fileSystem.makeDirectory(path.dirname(manifestPath), { recursive: true });
    return yield* build({ resourcesPath, manifestPath });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopInstallIntegrity", () => {
  it.effect("accepts an install whose unpacked build stamp matches the asar version", () =>
    withInstallDir(({ resourcesPath, manifestPath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(manifestPath, '{"version":"1.2.3"}\n');

        const result = yield* DesktopInstallIntegrity.checkInstallIntegrity.pipe(
          Effect.provide(
            makeEnvironmentLayer({
              resourcesPath,
              isPackaged: true,
              homeDirectory: `/tmp/t3-integrity-home-${process.pid}`,
            }),
          ),
        );
        assert.equal(result._tag, "Ok");
      }),
    ),
  );

  it.effect("flags a half-applied update whose unpacked files came from a different build", () =>
    withInstallDir(({ resourcesPath, manifestPath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        // The observed corruption: app.asar (and its version) stayed at the
        // old build while app.asar.unpacked was replaced by the new one.
        yield* fileSystem.writeFileString(manifestPath, '{"version":"1.2.4-nightly.1"}\n');

        const result = yield* DesktopInstallIntegrity.checkInstallIntegrity.pipe(
          Effect.provide(
            makeEnvironmentLayer({
              resourcesPath,
              isPackaged: true,
              homeDirectory: `/tmp/t3-integrity-home-${process.pid}`,
            }),
          ),
        );
        assert.equal(result._tag, "Mismatch");
        if (result._tag === "Mismatch") {
          assert.equal(result.appVersion, "1.2.3");
          assert.equal(result.unpackedVersion, "1.2.4-nightly.1");
        }
      }),
    ),
  );

  it.effect("treats a missing manifest on packaged Windows as a half-applied update", () =>
    withInstallDir(({ resourcesPath }) =>
      Effect.gen(function* () {
        // New app.asar (which ships this checker AND the stamp in the same
        // build) with a pre-stamp unpacked tree = partial apply. Skipping
        // here would launch straight into the mixed-build crash.
        const result = yield* DesktopInstallIntegrity.checkInstallIntegrity.pipe(
          Effect.provide(
            makeEnvironmentLayer({
              resourcesPath,
              isPackaged: true,
              homeDirectory: `/tmp/t3-integrity-home-${process.pid}`,
            }),
          ),
        );
        assert.equal(result._tag, "MissingManifest");
      }),
    ),
  );

  it.effect("skips a missing manifest on platforms that pack the server dist inside the asar", () =>
    withInstallDir(({ resourcesPath }) =>
      Effect.gen(function* () {
        const result = yield* DesktopInstallIntegrity.checkInstallIntegrity.pipe(
          Effect.provide(
            makeEnvironmentLayer({
              resourcesPath,
              isPackaged: true,
              platform: "darwin",
              homeDirectory: `/tmp/t3-integrity-home-${process.pid}`,
            }),
          ),
        );
        assert.equal(result._tag, "Skipped");
      }),
    ),
  );

  it.effect("skips an unreadable (but present) manifest instead of blocking launch", () =>
    withInstallDir(({ resourcesPath }) =>
      Effect.gen(function* () {
        // Access denied / I/O error is not evidence of a partial apply; a
        // false MissingManifest here would brick every launch of a healthy
        // install.
        const failingFs = FileSystem.layerNoop({
          readFileString: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: "desktop-build-manifest.json",
                description: "EACCES",
              }),
            ),
        });
        const result = yield* DesktopInstallIntegrity.checkInstallIntegrity.pipe(
          Effect.provide(
            Layer.mergeAll(
              makeEnvironmentLayer({
                resourcesPath,
                isPackaged: true,
                homeDirectory: `/tmp/t3-integrity-home-${process.pid}`,
              }),
              failingFs,
            ),
          ),
        );
        assert.equal(result._tag, "Skipped");
      }),
    ),
  );

  it.effect("skips undecodable manifests instead of blocking launch", () =>
    withInstallDir(({ resourcesPath, manifestPath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(manifestPath, "not json");

        const result = yield* DesktopInstallIntegrity.checkInstallIntegrity.pipe(
          Effect.provide(
            makeEnvironmentLayer({
              resourcesPath,
              isPackaged: true,
              homeDirectory: `/tmp/t3-integrity-home-${process.pid}`,
            }),
          ),
        );
        assert.equal(result._tag, "Skipped");
      }),
    ),
  );

  it.effect("resolves the releases page from the packaged update feed", () =>
    withInstallDir(({ resourcesPath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environmentLayer = makeEnvironmentLayer({
          resourcesPath,
          isPackaged: true,
          homeDirectory: `/tmp/t3-integrity-home-${process.pid}`,
        });
        const appUpdateYmlPath = yield* DesktopEnvironment.DesktopEnvironment.pipe(
          Effect.map((environment) => environment.appUpdateYmlPath),
          Effect.provide(environmentLayer),
        );
        yield* fileSystem.makeDirectory(
          appUpdateYmlPath.slice(0, appUpdateYmlPath.lastIndexOf("/")),
          { recursive: true },
        );
        yield* fileSystem.writeFileString(
          appUpdateYmlPath,
          "provider: github\nowner: pingdotgg\nrepo: t3code\n",
        );

        const url = yield* DesktopInstallIntegrity.resolveDownloadPageUrl.pipe(
          Effect.provide(environmentLayer),
        );
        assert.deepEqual(url, Option.some("https://github.com/pingdotgg/t3code/releases"));
      }),
    ),
  );
});

import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as Electron from "electron";

import { DEFAULT_CLIENT_SETTINGS, Edition } from "@lathe/contracts";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEditionIcon from "./DesktopEditionIcon.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

describe("resolveEditionIconLocation", () => {
  const resolve = (
    edition: DesktopEditionIcon.EditionIconSettings["edition"],
    platform: NodeJS.Platform,
    isPackaged: boolean,
  ) =>
    Path.Path.pipe(
      Effect.map((path) =>
        DesktopEditionIcon.resolveEditionIconLocation({
          edition,
          platform,
          isPackaged,
          rootDir: "/repo",
          path,
        }),
      ),
      Effect.provide(NodePath.layerPosix),
    );

  it.effect("reads the per-platform source asset when unpackaged", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* resolve("rain", "darwin", false), {
        _tag: "SourceTree",
        path: "/repo/assets/editions/rain/rain-macos-1024.png",
      });
      assert.deepEqual(yield* resolve("rain", "win32", false), {
        _tag: "SourceTree",
        path: "/repo/assets/editions/rain/rain-windows.ico",
      });
      assert.deepEqual(yield* resolve("rain", "linux", false), {
        _tag: "SourceTree",
        path: "/repo/assets/editions/rain/rain-universal-1024.png",
      });
    }),
  );

  it.effect("finds a repo icon for every edition on every platform", () =>
    Effect.gen(function* () {
      // The build stages these same files, so an edition added without icons fails here first.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = path.resolve(import.meta.dirname, "../../../..");
      for (const edition of Edition.literals) {
        for (const platform of ["darwin", "win32", "linux"] as const) {
          const location = DesktopEditionIcon.resolveEditionIconLocation({
            edition,
            platform,
            isPackaged: false,
            rootDir,
            path,
          });
          assert.strictEqual(location._tag, "SourceTree");
          if (location._tag === "SourceTree") {
            assert.isTrue(yield* fs.exists(location.path), location.path);
          }
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("maps blueprint to the development icons when unpackaged", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* resolve("blueprint", "darwin", false), {
        _tag: "SourceTree",
        path: "/repo/assets/lathe/dev/blueprint-macos-1024.png",
      });
      assert.deepEqual(yield* resolve("blueprint", "win32", false), {
        _tag: "SourceTree",
        path: "/repo/assets/lathe/dev/blueprint-windows.ico",
      });
      assert.deepEqual(yield* resolve("blueprint", "linux", false), {
        _tag: "SourceTree",
        path: "/repo/assets/lathe/dev/blueprint-universal-1024.png",
      });
    }),
  );

  it.effect("reads the staged resource when packaged", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* resolve("night-city", "darwin", true), {
        _tag: "Resource",
        fileName: "editions/night-city/macos.png",
      });
      assert.deepEqual(yield* resolve("night-city", "win32", true), {
        _tag: "Resource",
        fileName: "editions/night-city/windows.ico",
      });
      assert.deepEqual(yield* resolve("blueprint", "linux", true), {
        _tag: "Resource",
        fileName: "editions/blueprint/universal.png",
      });
    }),
  );
});

interface Calls {
  readonly setDockIcon: string[];
  resetDockIcon: number;
  readonly windowIcons: string[];
}

const makeCalls = (): Calls => ({ setDockIcon: [], resetDockIcon: 0, windowIcons: [] });

const makeWindow = (calls: Calls) =>
  ({
    setIcon: (icon: string) => {
      calls.windowIcons.push(icon);
    },
  }) as unknown as Electron.BrowserWindow;

const withEditionIcon = <A, E>(
  effect: Effect.Effect<A, E, DesktopEditionIcon.DesktopEditionIcon>,
  input: {
    readonly calls: Calls;
    readonly platform: NodeJS.Platform;
    readonly isPackaged: boolean;
    readonly existingPaths?: ReadonlyArray<string>;
    readonly resources?: ReadonlyArray<string>;
  },
) => {
  const existingPaths = new Set(input.existingPaths ?? []);
  const resources = new Set(input.resources ?? []);
  const window = makeWindow(input.calls);

  return effect.pipe(
    Effect.provide(
      DesktopEditionIcon.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              exists: (candidate) => Effect.succeed(existingPaths.has(candidate)),
            }),
            Layer.succeed(DesktopAssets.DesktopAssets, {
              iconPaths: Effect.succeed({
                ico: Option.some("/bundled/icon.ico"),
                icns: Option.none(),
                png: Option.some("/bundled/icon.png"),
              }),
              resolveResourcePath: (fileName) =>
                Effect.succeed(
                  resources.has(fileName) ? Option.some(`/resources/${fileName}`) : Option.none(),
                ),
            } satisfies DesktopAssets.DesktopAssets["Service"]),
            Layer.mock(ElectronApp.ElectronApp)({
              setDockIcon: (iconPath) =>
                Effect.sync(() => {
                  input.calls.setDockIcon.push(iconPath);
                }),
              resetDockIcon: Effect.sync(() => {
                input.calls.resetDockIcon += 1;
              }),
            }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              syncAllAppearance: (sync) => sync(window, { titleBarOverlay: false }),
            }),
            DesktopClientSettings.layerTest(
              Option.some({ ...DEFAULT_CLIENT_SETTINGS, edition: "amber" }),
            ),
            DesktopEnvironment.layer({
              dirname: "/repo/apps/desktop/dist-electron",
              homeDirectory: "/Users/alice",
              platform: input.platform,
              processArch: "arm64",
              appVersion: "1.2.3",
              appPath: "/app",
              isPackaged: input.isPackaged,
              resourcesPath: "/app/resources",
              runningUnderArm64Translation: false,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodePath.layerPosix,
                  DesktopConfig.layerTest({}),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};

describe("DesktopEditionIcon", () => {
  it.effect("sets the dock icon on macOS, packaged too", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: true });

        assert.deepEqual(calls.setDockIcon, ["/resources/editions/rain/macos.png"]);
        assert.deepEqual(calls.windowIcons, []);
      }),
      {
        calls,
        platform: "darwin",
        isPackaged: true,
        resources: ["editions/rain/macos.png"],
      },
    );
  });

  it.effect("sets every window icon on Windows and hands it to new windows", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        assert.deepEqual(yield* editionIcon.iconPath, Option.none());

        yield* editionIcon.apply({ edition: "rain", editionAppIcon: true });

        assert.deepEqual(calls.windowIcons, ["/resources/editions/rain/windows.ico"]);
        assert.deepEqual(calls.setDockIcon, []);
        assert.deepEqual(
          yield* editionIcon.iconPath,
          Option.some("/resources/editions/rain/windows.ico"),
        );
      }),
      {
        calls,
        platform: "win32",
        isPackaged: true,
        resources: ["editions/rain/windows.ico"],
      },
    );
  });

  it.effect("sets every window icon on Linux from the source tree when unpackaged", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.apply({ edition: "blueprint", editionAppIcon: true });

        assert.deepEqual(calls.windowIcons, [
          "/repo/assets/lathe/dev/blueprint-universal-1024.png",
        ]);
      }),
      {
        calls,
        platform: "linux",
        isPackaged: false,
        existingPaths: ["/repo/assets/lathe/dev/blueprint-universal-1024.png"],
      },
    );
  });

  it.effect("applies the stored edition on initialize", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.initialize;

        assert.deepEqual(calls.setDockIcon, ["/resources/editions/amber/macos.png"]);
      }),
      {
        calls,
        platform: "darwin",
        isPackaged: true,
        resources: ["editions/amber/macos.png"],
      },
    );
  });

  it.effect("skips a missing edition icon without failing", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.apply({ edition: "glitch", editionAppIcon: true });

        assert.deepEqual(calls, makeCalls());
        assert.deepEqual(yield* editionIcon.iconPath, Option.none());
      }),
      { calls, platform: "linux", isPackaged: true },
    );
  });

  it.effect("hands the packaged macOS dock back to the bundle icon when switched off", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: true });
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: false });

        assert.deepEqual(calls.setDockIcon, ["/resources/editions/rain/macos.png"]);
        assert.equal(calls.resetDockIcon, 1);
        assert.deepEqual(yield* editionIcon.iconPath, Option.none());
      }),
      {
        calls,
        platform: "darwin",
        isPackaged: true,
        resources: ["editions/rain/macos.png"],
      },
    );
  });

  it.effect("restores the development dock icon when switched off unpackaged", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: true });
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: false });

        assert.deepEqual(calls.setDockIcon, [
          "/repo/assets/editions/rain/rain-macos-1024.png",
          "/bundled/icon.png",
        ]);
        assert.equal(calls.resetDockIcon, 0);
      }),
      {
        calls,
        platform: "darwin",
        isPackaged: false,
        existingPaths: ["/repo/assets/editions/rain/rain-macos-1024.png"],
      },
    );
  });

  it.effect("restores the bundled window icon when switched off on Windows", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: true });
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: false });

        assert.deepEqual(calls.windowIcons, [
          "/resources/editions/rain/windows.ico",
          "/bundled/icon.ico",
        ]);
        assert.deepEqual(yield* editionIcon.iconPath, Option.none());
      }),
      {
        calls,
        platform: "win32",
        isPackaged: true,
        resources: ["editions/rain/windows.ico"],
      },
    );
  });

  it.effect("leaves the icon alone when switched off without having changed it", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: false });

        assert.deepEqual(calls, makeCalls());
      }),
      {
        calls,
        platform: "darwin",
        isPackaged: true,
        resources: ["editions/rain/macos.png"],
      },
    );
  });

  it.effect("does not reapply an unchanged edition", () => {
    const calls = makeCalls();
    return withEditionIcon(
      Effect.gen(function* () {
        const editionIcon = yield* DesktopEditionIcon.DesktopEditionIcon;
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: true });
        yield* editionIcon.apply({ edition: "rain", editionAppIcon: true });

        assert.deepEqual(calls.setDockIcon, ["/resources/editions/rain/macos.png"]);
      }),
      {
        calls,
        platform: "darwin",
        isPackaged: true,
        resources: ["editions/rain/macos.png"],
      },
    );
  });
});

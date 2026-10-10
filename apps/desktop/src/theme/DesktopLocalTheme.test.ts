import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopLocalTheme from "./DesktopLocalTheme.ts";

vi.mock("electron", () => ({}));

const dark = { name: "Desktop", appearance: "dark", canvas: "#123456", accent: "#abcdef" } as const;
const light = { ...dark, appearance: "light", canvas: "#f0e8d0" } as const;

const withDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "desktop-theme-test-" });
});

function layer(dir: string, file: string | undefined, messages: unknown[]) {
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: dir,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: dir, T3CODE_DESKTOP_THEME_FILE: file }),
      ),
    ),
  );
  return DesktopLocalTheme.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environment,
        NodeServices.layer,
        Layer.mock(ElectronWindow.ElectronWindow)({
          sendAll: (_channel, theme) =>
            Effect.sync(() => {
              messages.push(theme);
            }),
        }),
      ),
    ),
  );
}

const write = Effect.fnUntraced(function* (file: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${file}.tmp`, JSON.stringify(value));
  yield* fs.rename(`${file}.tmp`, file);
});

describe("desktop-local palette source", () => {
  it.effect(
    "loads with no backend and follows atomic replacements while rejecting invalid palettes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* withDirectory;
          const file = (yield* Path.Path).join(dir, "theme.json");
          yield* write(file, dark);
          const messages: unknown[] = [];
          yield* Effect.gen(function* () {
            const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
            assert.deepEqual(yield* themes.current, { enabled: true, theme: dark });
            yield* write(file, light);
            assert.deepEqual(yield* themes.current, { enabled: true, theme: light });
            yield* write(file, { ...light, canvas: "not a color" });
            assert.deepEqual(yield* themes.current, { enabled: true, theme: light });
            yield* write(file, { name: "Empty", appearance: "dark" });
            assert.deepEqual(yield* themes.current, { enabled: true, theme: light });
            yield* (yield* FileSystem.FileSystem).writeFileString(file, "x".repeat(40_000));
            assert.deepEqual(yield* themes.current, { enabled: true, theme: light });
            assert.deepEqual(messages, [
              { enabled: true, theme: dark },
              { enabled: true, theme: light },
            ]);
          }).pipe(Effect.provide(layer(dir, file, messages)));
          yield* write(file, dark);
          yield* Effect.gen(function* () {
            assert.deepEqual(yield* (yield* DesktopLocalTheme.DesktopLocalTheme).current, {
              enabled: true,
              theme: dark,
            });
          }).pipe(Effect.provide(layer(dir, file, [])));
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("does nothing unless explicitly configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const messages: unknown[] = [];
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* (yield* DesktopLocalTheme.DesktopLocalTheme).current, {
            enabled: false,
            theme: null,
          });
          assert.deepEqual(messages, []);
        }).pipe(Effect.provide(layer(dir, undefined, messages)));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("recovers when the palette directory is created after startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const subdir = (yield* Path.Path).join(dir, "later");
        const file = (yield* Path.Path).join(subdir, "theme.json");
        const messages: unknown[] = [];
        yield* Effect.gen(function* () {
          const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
          assert.deepEqual(yield* themes.current, { enabled: true, theme: null });
          yield* (yield* FileSystem.FileSystem).makeDirectory(subdir);
          yield* write(file, dark);
          yield* TestClock.adjust("31 seconds");
          assert.deepEqual(messages, [{ enabled: true, theme: dark }]);
          assert.deepEqual(yield* themes.current, { enabled: true, theme: dark });
        }).pipe(Effect.provide(layer(dir, file, messages)));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

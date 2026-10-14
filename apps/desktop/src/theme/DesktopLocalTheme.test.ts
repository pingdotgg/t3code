import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import type { DesktopLocalThemeState } from "@t3tools/contracts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopLocalTheme from "./DesktopLocalTheme.ts";

vi.mock("electron", () => ({}));

const dark = { name: "Desktop", appearance: "dark", canvas: "#123456", accent: "#abcdef" } as const;
const light = { ...dark, appearance: "light", canvas: "#f0e8d0" } as const;
const native = { appearance: "light", accent: "#0055aa" } as const;

const withDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "desktop-theme-test-" });
});

function layer(
  dir: string,
  file: string | null,
  send: (state: DesktopLocalThemeState) => Effect.Effect<void> = () => Effect.void,
  platform: NodeJS.Platform = "linux",
  nativeSource: {
    read: () => { appearance: "light" | "dark"; accent: string | null };
    listen: (listener: () => void) => void;
  } = { read: () => native, listen: () => undefined },
) {
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: dir,
    platform,
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: dir })),
    ),
  );
  return DesktopLocalTheme.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environment,
        NodeServices.layer,
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          localThemeFile: file,
        }),
        Layer.mock(ElectronTheme.ElectronTheme)({
          systemTheme: Effect.sync(nativeSource.read),
          onUpdated: (listener) => Effect.sync(() => nativeSource.listen(listener)),
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({
          sendAll: (_channel, state) => send(state as DesktopLocalThemeState),
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

function fileState(theme: typeof dark | typeof light, filePath: string): DesktopLocalThemeState {
  return {
    ...native,
    appearance: theme.appearance,
    source: "file",
    filePath,
    status: "ready",
    theme,
  };
}

describe("desktop system palette source", () => {
  it.live("follows atomic replacements through notifications without a getter refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const file = (yield* Path.Path).join(dir, "theme.json");
        yield* write(file, dark);
        const updated = yield* Deferred.make<void>();
        const send = (state: DesktopLocalThemeState) =>
          state.theme?.appearance === "light"
            ? Deferred.succeed(updated, undefined).pipe(Effect.asVoid)
            : Effect.void;
        yield* Effect.gen(function* () {
          const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
          assert.deepEqual(yield* themes.current, fileState(dark, file));
          yield* write(file, light);
          yield* Deferred.await(updated);
          assert.deepEqual(yield* themes.current, fileState(light, file));
        }).pipe(Effect.provide(layer(dir, file, send)));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("provides native appearance and accent without configuration or servers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* (yield* DesktopLocalTheme.DesktopLocalTheme).current, {
            ...native,
            source: "native",
            filePath: null,
            status: "ready",
            theme: null,
          });
        }).pipe(Effect.provide(layer(dir, null)));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("publishes native appearance and accent changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const updated = yield* Deferred.make<void>();
        let current: { appearance: "light" | "dark"; accent: string | null } = native;
        let notify: () => void = () => undefined;
        yield* Effect.gen(function* () {
          const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
          current = { appearance: "dark", accent: "#fedcba" };
          notify();
          yield* Deferred.await(updated);
          assert.deepEqual(yield* themes.current, {
            ...current,
            source: "native",
            filePath: null,
            status: "ready",
            theme: null,
          });
        }).pipe(
          Effect.provide(
            layer(
              dir,
              null,
              () => Deferred.succeed(updated, undefined).pipe(Effect.asVoid),
              "linux",
              {
                read: () => current,
                listen: (listener) => {
                  notify = listener;
                },
              },
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("chooses a saved file and clears it back to automatic detection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const file = (yield* Path.Path).join(dir, "theme.json");
        yield* write(file, dark);
        yield* Effect.gen(function* () {
          const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
          assert.deepEqual(yield* themes.setFile(file), fileState(dark, file));
          const changedSource = yield* themes.setFile(`${file}.missing`);
          assert.strictEqual(changedSource.source, "file");
          assert.strictEqual(changedSource.status, "missing");
          assert.strictEqual(changedSource.theme, null);
          assert.deepEqual(yield* themes.setFile(null), {
            ...native,
            source: "native",
            filePath: null,
            status: "ready",
            theme: null,
          });
        }).pipe(Effect.provide(layer(dir, null)));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("rejects invalid exported role colors and retains the last valid palette", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const file = (yield* Path.Path).join(dir, "theme.json");
        const exported = {
          name: "Exported",
          appearance: "dark",
          colors: { canvas: "oklch(0.2 0.01 240)", accent: "rebeccapurple" },
        } as const;
        yield* write(file, exported);
        yield* Effect.gen(function* () {
          const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
          assert.deepEqual((yield* themes.current).theme, exported);
          for (const colors of [{ canvas: "not a color" }, { futureUnknownRole: "#ffffff" }]) {
            yield* write(file, { ...exported, colors });
            const state = yield* themes.setFile(file);
            assert.strictEqual(state.status, "invalid");
            assert.deepEqual(state.theme, exported);
          }
          yield* (yield* FileSystem.FileSystem).writeFileString(file, "x".repeat(40_000));
          const state = yield* themes.setFile(file);
          assert.strictEqual(state.status, "invalid");
          assert.deepEqual(state.theme, exported);
        }).pipe(Effect.provide(layer(dir, file)));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("recovers a missing configured directory without reading through the getter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const subdir = (yield* Path.Path).join(dir, "later");
        const file = (yield* Path.Path).join(subdir, "theme.json");
        const updated = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
          assert.strictEqual((yield* themes.current).status, "missing");
          yield* (yield* FileSystem.FileSystem).makeDirectory(subdir);
          yield* write(file, dark);
          yield* TestClock.adjust("31 seconds");
          yield* Deferred.await(updated);
          assert.deepEqual(yield* themes.current, fileState(dark, file));
        }).pipe(
          Effect.provide(
            layer(dir, file, (state) =>
              state.theme === null
                ? Effect.void
                : Deferred.succeed(updated, undefined).pipe(Effect.asVoid),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("detects an Omarchy file on Linux and ignores it on other platforms", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const fs = yield* FileSystem.FileSystem;
        const file = (yield* Path.Path).join(dir, ".local/state/omarchy/current/theme/t3code.json");
        yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true });
        yield* write(file, dark);
        for (const platform of ["linux", "darwin", "win32"] as const) {
          yield* Effect.gen(function* () {
            const state = yield* (yield* DesktopLocalTheme.DesktopLocalTheme).current;
            assert.strictEqual(state.source, platform === "linux" ? "omarchy" : "native");
            assert.deepEqual(state.theme, platform === "linux" ? dark : null);
          }).pipe(Effect.provide(layer(dir, null, undefined, platform)));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("keeps the last Omarchy palette while its file is missing or invalid and recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, ".local/state/omarchy/current/theme/t3code.json");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* write(file, dark);
        const notifications = yield* Queue.unbounded<DesktopLocalThemeState>();
        yield* Effect.gen(function* () {
          const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
          yield* Queue.take(notifications);
          yield* fs.remove(file);
          const missing = yield* Queue.take(notifications);
          assert.deepEqual(missing, {
            ...fileState(dark, file),
            source: "omarchy",
            status: "missing",
          });
          assert.deepEqual(yield* themes.current, missing);
          yield* write(file, {
            name: "Invalid",
            appearance: "dark",
            colors: { canvas: "not a color" },
          });
          const invalid = yield* Queue.take(notifications);
          assert.deepEqual(invalid, { ...missing, status: "invalid" });
          yield* write(file, light);
          const recovered = yield* Queue.take(notifications);
          assert.deepEqual(recovered, { ...fileState(light, file), source: "omarchy" });
          assert.deepEqual(yield* themes.current, recovered);
        }).pipe(
          Effect.provide(
            layer(dir, null, (state) => Queue.offer(notifications, state).pipe(Effect.asVoid)),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("follows Omarchy's theme directory symlink switches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withDirectory;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = path.join(dir, ".local/state/omarchy/current");
        const first = path.join(dir, "first");
        const second = path.join(dir, "second");
        yield* fs.makeDirectory(parent, { recursive: true });
        yield* fs.makeDirectory(first);
        yield* fs.makeDirectory(second);
        yield* write(path.join(first, "t3code.json"), dark);
        yield* write(path.join(second, "t3code.json"), light);
        yield* fs.symlink(first, path.join(parent, "theme"));
        const updated = yield* Deferred.make<void>();
        const recolored = yield* Deferred.make<void>();
        const changed = { ...light, name: "Changed", canvas: "#ffeedd" };
        yield* Effect.gen(function* () {
          const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
          assert.deepEqual((yield* themes.current).theme, dark);
          yield* fs.symlink(second, path.join(parent, "next"));
          yield* fs.rename(path.join(parent, "next"), path.join(parent, "theme"));
          yield* Deferred.await(updated);
          assert.deepEqual((yield* themes.current).theme, light);
          yield* write(path.join(second, "t3code.json"), changed);
          yield* Deferred.await(recolored);
          assert.deepEqual((yield* themes.current).theme, changed);
        }).pipe(
          Effect.provide(
            layer(dir, null, (state) =>
              state.theme?.name === "Changed"
                ? Deferred.succeed(recolored, undefined).pipe(Effect.asVoid)
                : state.theme?.appearance === "light"
                  ? Deferred.succeed(updated, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

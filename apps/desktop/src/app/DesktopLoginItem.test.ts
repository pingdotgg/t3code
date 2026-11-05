import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("electron", () => ({
  app: { getLoginItemSettings: native.get, setLoginItemSettings: native.set },
}));

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLoginItem from "./DesktopLoginItem.ts";

const identity = "com.t3tools.t3code.beta";
const entryPath = `/home/alice/.config/autostart/${identity}.desktop`;
const executablePath = "C:\\Program Files\\T3 Code\\T3 Code.exe";

function setup(
  platform: NodeJS.Platform,
  overrides: Partial<DesktopEnvironment.DesktopEnvironment["Service"]> = {},
) {
  vi.resetAllMocks();
  const files = new Map<string, string>();
  const directories: string[] = [];
  const settings: Electron.LoginItemSettings = {
    openAtLogin: false,
    wasOpenedAtLogin: true,
    executableWillLaunchAtLogin: false,
    launchItems: [],
    status: "not-registered",
  };
  let rejectWrite = false;
  native.get.mockImplementation(() => settings);
  native.set.mockImplementation((next: Electron.Settings) => {
    const enabled = next.openAtLogin === true;
    // Electron's Windows getter uses the default registry name and omits switch arguments.
    settings.openAtLogin = platform === "win32" ? false : enabled;
    settings.status = enabled ? "enabled" : "not-registered";
    settings.executableWillLaunchAtLogin = enabled;
    settings.launchItems = enabled
      ? [
          {
            name: next.name ?? "",
            path: next.path ?? "",
            args: platform === "win32" ? [] : (next.args ?? []),
            scope: "user",
            enabled: true,
          },
        ]
      : [];
  });
  const layer = DesktopLoginItem.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          DesktopEnvironment.DesktopEnvironment,
          Path.Path.pipe(
            Effect.map(
              (path) =>
                ({
                  platform,
                  path,
                  appUserModelId: "com.t3tools.t3code",
                  branding: {
                    baseName: "T3 Code",
                    displayName: "T3 Code (Beta)",
                    stageLabel: "Beta",
                  },
                  displayName: "T3 Code (Beta)",
                  appDataDirectory: "/home/alice/.config",
                  isPackaged: true,
                  isDevelopment: false,
                  desktopLauncherPath: Option.none(),
                  appImagePath: Option.some("/home/alice/T3 100%.AppImage"),
                  ...overrides,
                }) as DesktopEnvironment.DesktopEnvironment["Service"],
            ),
            Effect.provide(Path.layer),
          ),
        ),
        Layer.succeed(HostProcess.ExecutablePath, executablePath),
        Layer.succeed(HostProcess.Arguments, [
          executablePath,
          DesktopLoginItem.LOGIN_ITEM_ARGUMENT,
        ]),
        FileSystem.layerNoop({
          readFileString: (path) =>
            files.has(path)
              ? Effect.succeed(files.get(path)!)
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "readFileString",
                  }),
                ),
          makeDirectory: (path) =>
            Effect.sync(() => {
              directories.push(path);
            }),
          makeTempFile: (options: Parameters<FileSystem.FileSystem["makeTempFile"]>[0]) =>
            Effect.sync(() => {
              const temporary = `${options?.directory}/.t3-login-temp`;
              files.set(temporary, "");
              return temporary;
            }),
          writeFileString: (path, content) =>
            rejectWrite
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFileString",
                  }),
                )
              : Effect.sync(() => {
                  files.set(path, content);
                }),
          rename: (from, to) =>
            Effect.sync(() => {
              files.set(to, files.get(from)!);
              files.delete(from);
            }),
          remove: (path) =>
            Effect.sync(() => {
              files.delete(path);
            }),
        }),
      ),
    ),
  );
  return {
    layer,
    files,
    directories,
    settings,
    rejectWrite: () => {
      rejectWrite = true;
    },
  };
}

it.effect.each(["win32", "darwin"] satisfies NodeJS.Platform[])(
  "registers and removes an explicit login item without writes during startup reads on %s",
  (platform) => {
    const harness = setup(platform);
    return Effect.gen(function* () {
      const login = yield* DesktopLoginItem.DesktopLoginItem;
      assert.isTrue(login.supported);
      assert.isFalse(yield* login.getEnabled);
      assert.isTrue(yield* login.wasOpenedAtLogin);
      assert.equal(native.set.mock.calls.length, 0);
      yield* login.configure(true);
      assert.isTrue(yield* login.getEnabled);
      if (platform === "win32") {
        assert.deepEqual(native.set.mock.lastCall?.[0], {
          openAtLogin: true,
          enabled: true,
          name: identity,
          path: executablePath,
          args: [DesktopLoginItem.LOGIN_ITEM_ARGUMENT],
        });
        assert.deepEqual(native.get.mock.lastCall?.[0], {
          path: executablePath,
          args: [DesktopLoginItem.LOGIN_ITEM_ARGUMENT],
        });
        harness.settings.launchItems[0]!.enabled = false;
        harness.settings.launchItems.push({
          name: "another-app",
          path: executablePath,
          args: [],
          scope: "user",
          enabled: true,
        });
      } else {
        assert.deepEqual(native.set.mock.lastCall?.[0], {
          openAtLogin: true,
          type: "mainAppService",
        });
        harness.settings.status = "requires-approval";
      }
      assert.isFalse(yield* login.getEnabled);
      assert.equal(native.set.mock.calls.length, 1);
      yield* login.configure(false);
      assert.isFalse(yield* login.getEnabled);
      assert.equal(native.set.mock.lastCall?.[0].openAtLogin, false);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("reports macOS login permission refusal instead of claiming it was enabled", () => {
  const harness = setup("darwin");
  harness.settings.status = "requires-approval";
  native.set.mockImplementation(() => {});
  return Effect.gen(function* () {
    const login = yield* DesktopLoginItem.DesktopLoginItem;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(login.configure(true))));
    assert.isFalse(yield* login.getEnabled);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["win32", "darwin", "linux"] satisfies NodeJS.Platform[])(
  "never registers a development process on %s",
  (platform) => {
    const harness = setup(platform, { isPackaged: false });
    return Effect.gen(function* () {
      const login = yield* DesktopLoginItem.DesktopLoginItem;
      assert.isFalse(login.supported);
      assert.isFalse(yield* login.getEnabled);
      assert.isFalse(yield* login.wasOpenedAtLogin);
      yield* login.configure(false);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(login.configure(true))));
      assert.equal(native.set.mock.calls.length, 0);
      assert.equal(native.get.mock.calls.length, 0);
      assert.equal(harness.files.size, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "writes a quoted XDG autostart entry and respects external disabling without rewriting it",
  () => {
    const harness = setup("linux");
    harness.files.set("/home/alice/.config/autostart/another-app.desktop", "unrelated");
    return Effect.gen(function* () {
      const login = yield* DesktopLoginItem.DesktopLoginItem;
      assert.isFalse(yield* login.getEnabled);
      assert.isTrue(yield* login.wasOpenedAtLogin);
      assert.deepEqual(harness.directories, []);
      yield* login.configure(true);
      assert.equal(
        harness.files.get(entryPath),
        '[Desktop Entry]\nType=Application\nName=T3 Code (Beta)\nExec="/home/alice/T3 100%%.AppImage" --t3-login-startup\nTerminal=false\nStartupNotify=false\n\n',
      );
      assert.isTrue(yield* login.getEnabled);
      for (const disabled of ["Hidden=true", "X-GNOME-Autostart-enabled=false"]) {
        harness.files.set(entryPath, `[Desktop Entry]\nType=Application\nExec=t3\n${disabled}\n`);
        assert.isFalse(yield* login.getEnabled);
        assert.isTrue(harness.files.get(entryPath)!.includes(disabled));
      }
      yield* login.configure(false);
      assert.isFalse(harness.files.has(entryPath));
      assert.equal(
        harness.files.get("/home/alice/.config/autostart/another-app.desktop"),
        "unrelated",
      );
      assert.equal(native.set.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("preserves the previous Linux entry when its replacement cannot be written", () => {
  const harness = setup("linux", {
    desktopLauncherPath: Option.some("/opt/t3/launcher"),
    appImagePath: Option.none(),
  });
  harness.files.set(entryPath, "previous");
  harness.rejectWrite();
  return Effect.gen(function* () {
    const login = yield* DesktopLoginItem.DesktopLoginItem;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(login.configure(true))));
    assert.deepEqual([...harness.files.entries()], [[entryPath, "previous"]]);
  }).pipe(Effect.provide(harness.layer));
});

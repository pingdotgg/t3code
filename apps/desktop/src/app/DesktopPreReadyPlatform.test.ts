import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  setDesktopNameMock,
  setNameMock,
  mkdirSyncMock,
  writeFileSyncMock,
  copyFileSyncMock,
  execFileSyncMock,
  readFileSyncMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  setNameMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    getVersion: () => "0.0.37",
    isPackaged: true,
    getAppPath: () => "/tmp/.mount_T3/resources/app.asar",
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  copyFileSync: copyFileSyncMock,
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

// Fork entry/desktop names come from the runtime distro, not upstream's reverse-DNS default.
const iconPath = "/xdg/icons/t3code.desktop.png";
const desktopEntryPath = "/xdg/applications/t3code.desktop";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    setNameMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    copyFileSyncMock.mockReset();
    execFileSyncMock.mockReset();
    readFileSyncMock.mockReset().mockReturnValue("{}");
  });

  it.effect("persists Linux scaling synchronously across relaunches and settings rewrites", () => {
    vi.stubEnv("T3CODE_HOME", "/isolated");
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    const settingsPath = "/isolated/userdata/desktop-settings.json";
    const files = new Map([[settingsPath, "{}"]]);
    const commandLine = new Map<string, string>();
    readFileSyncMock.mockImplementation((path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string) => {
      files.set(path, contents);
    });
    hasSwitchMock.mockImplementation((name: string) => commandLine.has(name));
    getSwitchValueMock.mockImplementation((name: string) => commandLine.get(name) ?? "");
    appendSwitchMock.mockImplementation((name: string, value: string) => {
      commandLine.set(name, value);
    });
    const launch = Effect.gen(function* () {
      const startup = Promise.resolve().then(() => commandLine.get("force-device-scale-factor"));
      yield* DesktopPreReadyPlatform.make;
      return yield* Effect.promise(() => startup);
    });

    return Effect.gen(function* () {
      for (const explicitScale of ["1.75", "1"]) {
        commandLine.clear();
        commandLine.set("force-device-scale-factor", explicitScale);
        appendSwitchMock.mockClear();
        assert.equal(yield* launch, explicitScale);
        assert.isFalse(
          appendSwitchMock.mock.calls.some(([name]) => name === "force-device-scale-factor"),
        );

        // The settings service discards fields it does not own when rewriting its document.
        files.set(settingsPath, JSON.stringify({ linuxPasswordStore: "basic" }));
        commandLine.clear();
        assert.equal(yield* launch, explicitScale);
      }
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect.each(["darwin", "win32"] as const)("leaves device scaling alone on %s", (platform) => {
    readFileSyncMock.mockReturnValue("1.75");
    hasSwitchMock.mockImplementation((name: string) => name === "force-device-scale-factor");
    getSwitchValueMock.mockReturnValue("2");

    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      assert.deepEqual(readFileSyncMock.mock.calls, []);
      assert.deepEqual(writeFileSyncMock.mock.calls, []);
      assert.deepEqual(appendSwitchMock.mock.calls, []);
    }).pipe(Effect.provideService(HostProcess.Platform, platform));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("preserves an explicit Linux password-store switch", () => {
    hasSwitchMock.mockImplementation((switchName) => switchName === "password-store");
    getSwitchValueMock.mockReturnValue(" basic ");

    return Effect.gen(function* () {
      const options = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;

      assert.equal(options.linuxPasswordStoreCommandLine, "basic");
      assert.isFalse(appendSwitchMock.mock.calls.some(([name]) => name === "password-store"));
    }).pipe(
      Effect.provide(
        DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
        ),
      ),
    );
  });

  it("detects --version and -V as whole-token version requests", () => {
    assert.isTrue(DesktopPreReadyPlatform.isVersionRequest(["--version"]));
    assert.isTrue(DesktopPreReadyPlatform.isVersionRequest(["-V"]));
    assert.isFalse(DesktopPreReadyPlatform.isVersionRequest(["--no-sandbox"]));
    assert.isFalse(DesktopPreReadyPlatform.isVersionRequest(["--version=1"]));
    assert.isFalse(DesktopPreReadyPlatform.isVersionRequest(["--version-foo"]));
    assert.isFalse(DesktopPreReadyPlatform.isVersionRequest(["-v"]));
    assert.isFalse(DesktopPreReadyPlatform.isVersionRequest([]));
  });

  it("writes a version line to stdout synchronously and swallows EPIPE", () => {
    const writes: Array<{ fd: number; data: string }> = [];
    DesktopPreReadyPlatform.writeStdoutLineSync("1.2.3", (fd, data) => {
      writes.push({ fd, data });
    });
    assert.deepEqual(writes, [{ fd: 1, data: "1.2.3\n" }]);

    DesktopPreReadyPlatform.writeStdoutLineSync("1.2.3", () => {
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    });

    try {
      DesktopPreReadyPlatform.writeStdoutLineSync("1.2.3", () => {
        throw Object.assign(new Error("bad fd"), { code: "EBADF" });
      });
      assert.fail("expected EBADF to propagate");
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "EBADF");
    }
  });
  // The window class follows the desktop name, which must match StartupWMClass.
  it.effect("names the packaged Linux desktop entry without a --class switch", () =>
    Effect.gen(function* () {
      vi.stubEnv("VITE_DEV_SERVER_URL", "");
      hasSwitchMock.mockReturnValue(false);

      const preReadyLayer = DesktopPreReadyPlatform.layer.pipe(
        Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
      );
      const options = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions.pipe(
        Effect.provide(preReadyLayer),
      );

      assert.equal(options.linux?.linuxDesktopEntryName, "t3code.desktop");
      assert.isFalse(appendSwitchMock.mock.calls.some(([name]) => name === "class"));
    }),
  );

  it.effect.each([
    { previousEntry: undefined, label: "missing" },
    { previousEntry: 'Exec="/Applications/deleted-previous.AppImage" %U', label: "stale" },
  ])("prepares a $label Linux desktop entry before startup yields", ({ previousEntry }) => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
    getSwitchValueMock.mockReturnValue("");
    let desktopName = "t3code.desktop";
    let desktopEntry = previousEntry;
    let iconInstalled = false;
    copyFileSyncMock.mockImplementation((_source: string, destination: string) => {
      iconInstalled = destination === iconPath;
    });
    setDesktopNameMock.mockImplementation((name: string) => {
      desktopName = name;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string) => {
      if (path === desktopEntryPath) desktopEntry = contents;
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const portalIdentity = Promise.resolve().then(() => ({
          desktopName,
          desktopEntry,
          iconInstalled,
        }));
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
          ),
        );
        const identity = yield* Effect.promise(() => portalIdentity);
        // Fork entry/desktop names come from the runtime distro, not
        // upstream's reverse-DNS default; branding carries no channel suffix.
        assert.equal(identity.desktopName, "t3code.desktop");
        assert.include(identity.desktopEntry ?? "", "Exec=/Applications/current.AppImage %U");
        assert.include(identity.desktopEntry ?? "", "Name=T3 Code\n");
        assert.include(identity.desktopEntry ?? "", "MimeType=x-scheme-handler/t3code;");
        assert.include(identity.desktopEntry ?? "", "Icon=/xdg/icons/t3code.desktop.png");
        assert.isTrue(identity.iconInstalled);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect.each(["linux", "darwin", "win32"] as const)(
    // MT Code builds always shipped under their packaged productName, so the
    // safeStorage key keeps that name instead of a "T3 Code (Alpha)" pin.
    "keeps the packaged %s encryption identity before startup yields",
    (platform) => {
      getSwitchValueMock.mockReturnValue("");
      let appName = "MT Code";
      setNameMock.mockImplementation((name: string) => {
        appName = name;
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const nameBeforeYield = Promise.resolve().then(() => appName);
          yield* Layer.build(
            DesktopPreReadyPlatform.layer.pipe(
              Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
            ),
          );
          assert.equal(yield* Effect.promise(() => nameBeforeYield), "MT Code");
          assert.equal(setNameMock.mock.calls.length, 0);
        }),
      );
    },
  );

  it.effect("keeps startup available when the early desktop entry cannot be written", () => {
    getSwitchValueMock.mockReturnValue("");
    mkdirSyncMock.mockImplementation(() => {
      throw new Error("read-only filesystem");
    });

    return DesktopPreReadyPlatform.make.pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.asVoid,
    );
  });

  it.effect("still prepares the portal entry when the bundled icon cannot be copied", () => {
    getSwitchValueMock.mockReturnValue("");
    copyFileSyncMock.mockImplementation(() => {
      throw new Error("missing bundled icon");
    });
    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      const contents = writeFileSyncMock.mock.calls[0]?.[1];
      assert.include(contents, "MimeType=x-scheme-handler/t3code;");
      assert.include(contents, "Icon=");
      assert.equal(setDesktopNameMock.mock.calls.length, 1);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux"));
  });

  it.effect("points the early portal entry at a configured distribution launcher", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
    vi.stubEnv("T3CODE_DESKTOP_LAUNCHER_PATH", " /opt/T3 Code/t3code ");
    getSwitchValueMock.mockReturnValue("");

    return Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
          ),
        );
        const entry = writeFileSyncMock.mock.calls.find(([path]) => path === desktopEntryPath)?.[1];
        assert.include(entry, 'Exec="/opt/T3 Code/t3code" %U');
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@t3tools/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });

        const layerPreReady = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
        );

        const layerClerkShaped = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const layerRuntime = layerClerkShaped.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(layerPreReady),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(layerRuntime));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
          },
        });
        assert.deepEqual(events, ["pre-ready", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
        assert.equal(setDesktopNameMock.mock.calls.length, 0);
      }),
  );
});

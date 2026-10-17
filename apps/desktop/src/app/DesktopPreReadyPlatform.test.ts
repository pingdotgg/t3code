import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  setDesktopNameMock,
  mkdirSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
  copyFileSyncMock,
  execFileSyncMock,
  electronState,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  electronState: { isPackaged: true },
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
    getVersion: () => "0.0.37",
    get isPackaged() {
      return electronState.isPackaged;
    },
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

const iconSource = "/tmp/.mount_T3/resources/app.asar/apps/desktop/prod-resources/icon.png";
const iconPath = "/xdg/icons/com.t3tools.T3Code.desktop.png";
const desktopEntryPath = "/xdg/applications/com.t3tools.T3Code.desktop";
const iconBytes = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x80, 0x0a]);

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    mkdirSyncMock.mockReset();
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    copyFileSyncMock.mockReset();
    execFileSyncMock.mockReset();
    electronState.isPackaged = true;
    readFileSyncMock.mockImplementation((path: string) => {
      if (path.endsWith("/desktop-settings.json")) return "{}";
      if (path === iconSource) return Buffer.from(iconBytes);
      throw new Error(`missing file: ${path}`);
    });
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

  it.effect.each([
    {
      label: "merges the color-manager fallback into disabled features on Hyprland 0.48.1",
      switches: { "ozone-platform": "wayland", "disable-features": "Vulkan" },
      hyprlandVersion: "0.48.1",
      hyprlandCommit: "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc",
      expected: [["disable-features", "Vulkan,WaylandWpColorManagerV1"]],
    },
    {
      label: "preserves color management on Hyprland 0.51.0",
      switches: { "ozone-platform": "wayland", "disable-features": "Vulkan" },
      hyprlandVersion: "0.51.0",
      hyprlandCommit: "0123456789abcdef0123456789abcdef01234567",
      expected: [],
    },
    {
      label: "preserves color management when Electron resolved X11",
      switches: { "ozone-platform": "x11", "disable-features": "Vulkan" },
      hyprlandVersion: "0.48.1",
      hyprlandCommit: "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc",
      expected: [],
    },
  ])("$label", ({ switches, hyprlandVersion, hyprlandCommit, expected }) => {
    vi.stubEnv("XDG_CURRENT_DESKTOP", "Hyprland");
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const commandLine = new Map<string, string>(Object.entries(switches));
    hasSwitchMock.mockImplementation((switchName: string) => commandLine.has(switchName));
    getSwitchValueMock.mockImplementation(
      (switchName: string) => commandLine.get(switchName) ?? "",
    );
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        commit: hyprlandCommit,
        version: hyprlandVersion,
        dirty: false,
        tag: `v${hyprlandVersion}`,
      }),
    );

    return DesktopPreReadyPlatform.make.pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.map(() => {
        const featureSwitches = appendSwitchMock.mock.calls.filter(([name]) =>
          ["disable-features", "enable-features", "ozone-platform"].includes(name),
        );
        assert.deepEqual(featureSwitches, expected);
      }),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

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
    setDesktopNameMock.mockImplementation((name: string) => {
      desktopName = name;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string | Buffer) => {
      if (path === iconPath)
        iconInstalled = Buffer.isBuffer(contents) && contents.equals(iconBytes);
      if (path === desktopEntryPath && typeof contents === "string") desktopEntry = contents;
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
        assert.equal(identity.desktopName, "com.t3tools.T3Code.desktop");
        assert.include(identity.desktopEntry ?? "", 'Exec="/Applications/current.AppImage" %U');
        assert.include(identity.desktopEntry ?? "", "Name=T3 Code (Beta)");
        assert.include(identity.desktopEntry ?? "", "MimeType=x-scheme-handler/t3code;");
        assert.include(
          identity.desktopEntry ?? "",
          "Icon=/xdg/icons/com.t3tools.T3Code.desktop.png",
        );
        assert.isTrue(identity.iconInstalled);
        assert.deepEqual(
          readFileSyncMock.mock.calls.filter(([path]) => path === iconSource),
          [[iconSource]],
        );
        assert.deepEqual(
          writeFileSyncMock.mock.calls.filter(([path]) => path === iconPath),
          [[iconPath, iconBytes, { mode: 0o600 }]],
        );
        assert.equal(copyFileSyncMock.mock.calls.length, 0);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

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

  it.effect.each([
    { label: "missing", current: undefined },
    { label: "equal", current: Buffer.from(iconBytes) },
    { label: "changed", current: Buffer.from([0x89, 0x50, 0x00, 0xfe, 0x80, 0x0a]) },
    { label: "shorter", current: iconBytes.subarray(0, -1) },
  ])("installs binary icon bytes only for a $label destination", ({ current }) => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    getSwitchValueMock.mockReturnValue("");
    const readFile = readFileSyncMock.getMockImplementation()!;
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === iconPath && current !== undefined) return current;
      return readFile(path);
    });

    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      assert.equal(copyFileSyncMock.mock.calls.length, 0);
      assert.deepEqual(
        readFileSyncMock.mock.calls.filter(([path]) => path === iconSource),
        [[iconSource]],
      );
      assert.deepEqual(
        readFileSyncMock.mock.calls.filter(([path]) => path === iconPath),
        [[iconPath]],
      );
      assert.deepEqual(
        writeFileSyncMock.mock.calls.filter(([path]) => path === iconPath),
        current?.equals(iconBytes) ? [] : [[iconPath, iconBytes, { mode: 0o600 }]],
      );
      assert.equal(
        writeFileSyncMock.mock.calls.filter(([path]) => path === desktopEntryPath).length,
        1,
      );
      assert.deepEqual(setDesktopNameMock.mock.calls, [["com.t3tools.T3Code.desktop"]]);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect.each(["readFileSync", "writeFileSync"] as const)(
    "still prepares the portal entry when the icon %s fails",
    (method) => {
      vi.stubEnv("VITE_DEV_SERVER_URL", "");
      vi.stubEnv("XDG_DATA_HOME", "/xdg");
      getSwitchValueMock.mockReturnValue("");
      const readFile = readFileSyncMock.getMockImplementation()!;
      let installedIcon = Buffer.from([0xff, 0x00]);
      let failures = 0;
      readFileSyncMock.mockImplementation((path: string) => {
        if (path === iconSource && method === "readFileSync") {
          failures++;
          throw new Error("unreadable bundled icon");
        }
        if (path === iconPath) return installedIcon;
        return readFile(path);
      });
      writeFileSyncMock.mockImplementation((path: string, contents: Buffer) => {
        if (path !== iconPath) return;
        if (method === "writeFileSync") {
          failures++;
          throw new Error("read-only icon directory");
        }
        installedIcon = Buffer.from(contents);
      });

      return Effect.gen(function* () {
        yield* DesktopPreReadyPlatform.make;
        assert.equal(failures, 1, "the failing filesystem operation must be reached");
        assert.deepEqual(installedIcon, Buffer.from([0xff, 0x00]));
        assert.equal(
          writeFileSyncMock.mock.calls.filter(([path]) => path === iconPath).length,
          method === "readFileSync" ? 0 : 1,
        );
        assert.equal(copyFileSyncMock.mock.calls.length, 0);
        const contents = writeFileSyncMock.mock.calls.find(
          ([path]) => path === desktopEntryPath,
        )?.[1];
        assert.include(contents, "MimeType=x-scheme-handler/t3code;");
        assert.include(contents, "Icon=");
        assert.deepEqual(setDesktopNameMock.mock.calls, [["com.t3tools.T3Code.desktop"]]);
      }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
      );
    },
  );

  it.effect("keeps unpackaged development setup free of icon reads and writes", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    electronState.isPackaged = false;
    getSwitchValueMock.mockReturnValue("");

    return DesktopPreReadyPlatform.make.pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.map(() => {
        assert.deepEqual(
          readFileSyncMock.mock.calls.filter(([path]) => path === iconSource),
          [],
        );
        assert.equal(copyFileSyncMock.mock.calls.length, 0);
        assert.equal(writeFileSyncMock.mock.calls.length, 1);
        assert.equal(
          writeFileSyncMock.mock.calls[0]?.[0],
          "/xdg/applications/com.t3tools.T3Code.Development.desktop",
        );
        assert.notInclude(writeFileSyncMock.mock.calls[0]?.[1], "Icon=");
        assert.deepEqual(setDesktopNameMock.mock.calls, [
          ["com.t3tools.T3Code.Development.desktop"],
        ]);
      }),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
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
        assert.equal(readFileSyncMock.mock.calls.length, 0);
        assert.equal(writeFileSyncMock.mock.calls.length, 0);
        assert.equal(copyFileSyncMock.mock.calls.length, 0);
      }),
  );
});

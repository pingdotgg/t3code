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
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
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
    readFileSyncMock.mockReset().mockImplementation((path: string) => {
      if (path.endsWith("/desktop-settings.json")) return "{}";
      if (path === iconSource) return Buffer.from(iconBytes);
      throw new Error(`missing file: ${path}`);
    });
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
        assert.include(identity.desktopEntry ?? "", "Exec=/Applications/current.AppImage %U");
        assert.include(identity.desktopEntry ?? "", "Name=T3 Code (Beta)");
        assert.include(identity.desktopEntry ?? "", "MimeType=x-scheme-handler/t3code;");
        assert.include(
          identity.desktopEntry ?? "",
          "Icon=/xdg/icons/com.t3tools.T3Code.desktop.png",
        );
        assert.isTrue(identity.iconInstalled);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect("refreshes a stale icon once across repeated launches", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    getSwitchValueMock.mockReturnValue("");
    let installedIcon = Buffer.from([0x89, 0x50, 0x00, 0xfe, 0x80, 0x0a]);
    let iconWrites = 0;
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === iconSource) return Buffer.from(iconBytes);
      if (path === iconPath) return Buffer.from(installedIcon);
      return "{}";
    });
    writeFileSyncMock.mockImplementation((path: string, contents: Buffer) => {
      if (path !== iconPath) return;
      installedIcon = Buffer.from(contents);
      iconWrites += 1;
    });

    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      assert.deepEqual(installedIcon, iconBytes);
      yield* DesktopPreReadyPlatform.make;
      assert.deepEqual(installedIcon, iconBytes);
      assert.equal(iconWrites, 1);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect("still prepares the portal entry when the bundled icon cannot be read", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    getSwitchValueMock.mockReturnValue("");
    const written = new Map<string, Array<string | Buffer>>();
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === iconSource) throw new Error("unreadable bundled icon");
      return "{}";
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string | Buffer) => {
      written.set(path, [...(written.get(path) ?? []), contents]);
    });

    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      const entries = written.get(desktopEntryPath) ?? [];
      assert.equal(entries.length, 1);
      assert.include(String(entries[0]), `Icon=${iconPath}`);
      assert.isFalse(written.has(iconPath));
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
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
      }),
  );
});

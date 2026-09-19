import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  removeSwitchMock,
  registerSchemesMock,
  setDesktopNameMock,
  mkdirSyncMock,
  writeFileSyncMock,
  readFileSyncMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  removeSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(() => "{}"),
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
    getVersion: () => "0.0.37",
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
      removeSwitch: removeSwitchMock,
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
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    removeSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    readFileSyncMock.mockReset().mockReturnValue("{}");
  });

  it.effect("restores the saved Linux device scale before startup yields", () => {
    readFileSyncMock.mockReturnValue('{"linuxDeviceScaleFactor":2}');

    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      assert.deepEqual(
        appendSwitchMock.mock.calls.filter(([name]) => name === "force-device-scale-factor"),
        [["force-device-scale-factor", "2"]],
      );
    }).pipe(Effect.provideService(HostProcessPlatform, "linux"));
  });

  it.effect("keeps a valid explicit device scale ahead of saved settings", () => {
    readFileSyncMock.mockReturnValue('{"linuxDeviceScaleFactor":2}');
    hasSwitchMock.mockImplementation((name) => name === "force-device-scale-factor");
    getSwitchValueMock.mockReturnValue("1.5");

    return Effect.gen(function* () {
      const options = yield* DesktopPreReadyPlatform.make;
      assert.equal(options.linuxDeviceScaleFactorCommandLine, 1.5);
      assert.isFalse(
        appendSwitchMock.mock.calls.some(([name]) => name === "force-device-scale-factor"),
      );
      assert.equal(removeSwitchMock.mock.calls.length, 0);
    }).pipe(Effect.provideService(HostProcessPlatform, "linux"));
  });

  for (const value of ["0", "-1", "Infinity", "", "NaN", "not-a-number"]) {
    for (const savedScale of [2, null]) {
      it.effect(`ignores invalid device scale '${value}' with saved scale ${savedScale}`, () => {
        readFileSyncMock.mockReturnValue(`{"linuxDeviceScaleFactor":${savedScale}}`);
        const switches = new Map([["force-device-scale-factor", value]]);
        hasSwitchMock.mockImplementation((name) => switches.has(name));
        getSwitchValueMock.mockImplementation((name) => switches.get(name) ?? "");
        removeSwitchMock.mockImplementation((name) => switches.delete(name));
        appendSwitchMock.mockImplementation((name, nextValue) => {
          // Model an existing switch taking precedence over a later append.
          if (!switches.has(name)) switches.set(name, nextValue);
        });

        return Effect.gen(function* () {
          const options = yield* DesktopPreReadyPlatform.make;
          assert.equal(options.linuxDeviceScaleFactorCommandLine, null);
          assert.equal(
            switches.get("force-device-scale-factor"),
            savedScale === null ? undefined : String(savedScale),
          );
        }).pipe(Effect.provideService(HostProcessPlatform, "linux"));
      });
    }
  }

  for (const platform of ["darwin", "win32"] as const) {
    it.effect(`does not restore Linux display scaling on ${platform}`, () => {
      readFileSyncMock.mockReturnValue('{"linuxDeviceScaleFactor":2}');
      hasSwitchMock.mockImplementation((name) => name === "force-device-scale-factor");
      getSwitchValueMock.mockReturnValue("0");
      return Effect.gen(function* () {
        const options = yield* DesktopPreReadyPlatform.make;
        assert.equal(options.linuxDeviceScaleFactorCommandLine, null);
        assert.isFalse(
          appendSwitchMock.mock.calls.some(([name]) => name === "force-device-scale-factor"),
        );
        assert.equal(removeSwitchMock.mock.calls.length, 0);
      }).pipe(Effect.provideService(HostProcessPlatform, platform));
    });
  }

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
          Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
        ),
      ),
    );
  });

  for (const previousEntry of [undefined, 'Exec="/Applications/deleted-previous.AppImage" %U']) {
    it.effect(
      `prepares a ${previousEntry ? "stale" : "missing"} Linux desktop entry before startup yields`,
      () => {
        vi.stubEnv("VITE_DEV_SERVER_URL", "");
        vi.stubEnv("XDG_DATA_HOME", "/xdg");
        vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
        getSwitchValueMock.mockReturnValue("");
        let desktopName = "t3code.desktop";
        let desktopEntry = previousEntry;
        setDesktopNameMock.mockImplementation((name: string) => {
          desktopName = name;
        });
        writeFileSyncMock.mockImplementation((path: string, contents: string) => {
          if (path === "/xdg/applications/com.t3tools.T3Code.desktop") desktopEntry = contents;
        });

        return Effect.scoped(
          Effect.gen(function* () {
            const portalIdentity = Promise.resolve().then(() => ({ desktopName, desktopEntry }));
            yield* Layer.build(
              DesktopPreReadyPlatform.layer.pipe(
                Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
              ),
            );
            const identity = yield* Effect.promise(() => portalIdentity);
            assert.equal(identity.desktopName, "com.t3tools.T3Code.desktop");
            assert.include(identity.desktopEntry ?? "", 'Exec="/Applications/current.AppImage" %U');
            assert.include(identity.desktopEntry ?? "", "Name=T3 Code (Alpha)");
            assert.include(identity.desktopEntry ?? "", "MimeType=x-scheme-handler/t3code;");
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
      },
    );
  }

  it.effect("keeps startup available when the early desktop entry cannot be written", () => {
    getSwitchValueMock.mockReturnValue("");
    mkdirSyncMock.mockImplementation(() => {
      throw new Error("read-only filesystem");
    });

    return DesktopPreReadyPlatform.make.pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.asVoid,
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

        const preReadyLayer = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
        );

        const clerkShapedLayer = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const runtimeLayer = clerkShapedLayer.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(preReadyLayer),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(runtimeLayer));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
            linuxDeviceScaleFactorCommandLine: null,
          },
        });
        assert.deepEqual(events, ["pre-ready", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
        assert.equal(setDesktopNameMock.mock.calls.length, 0);
      }),
  );
});

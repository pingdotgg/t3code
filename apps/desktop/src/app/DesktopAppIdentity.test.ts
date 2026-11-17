import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>;
};

interface ElectronAppCalls {
  readonly setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions>;
  readonly setDockIcon: Array<string | null>;
  readonly setName: string[];
  readonly setWindowIcons?: string[];
}

const layerElectronApp = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    preferredSystemLanguages: Effect.succeed(["en-US"]),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: (name) =>
      Effect.sync(() => {
        calls.setName.push(name);
      }),
    setAboutPanelOptions: (options) =>
      Effect.sync(() => {
        calls.setAboutPanelOptions.push(options);
      }),
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: (iconPath) =>
      Effect.sync(() => {
        calls.setDockIcon.push(iconPath);
      }),
    setWindowIcons: (iconPath) =>
      Effect.sync(() => {
        calls.setWindowIcons?.push(iconPath);
      }),
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

// The real service, so app icon choices resolve to real paths, with the build icon fixed.
const layerAssets = (png: Option.Option<string>) =>
  Layer.effect(
    DesktopAssets.DesktopAssets,
    Effect.map(DesktopAssets.make, (assets) =>
      DesktopAssets.DesktopAssets.of({
        ...assets,
        iconPaths: Effect.succeed({ ico: Option.none(), icns: Option.none(), png }),
      }),
    ),
  );

const layerEnvironment = (overrides: TestEnvironmentInput = {}) => {
  const { env, ...environmentOverrides } = overrides;
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodePath.layerPosix,
        DesktopConfig.layerTest({
          ...env,
        }),
      ),
    ),
  );
};

const withIdentity = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppIdentity.DesktopAppIdentity
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
  input: {
    readonly calls?: ElectronAppCalls;
    readonly environment?: TestEnvironmentInput;
    readonly legacyPathExists?: boolean;
    readonly legacyPathProbeError?: PlatformError.PlatformError;
    readonly packageJson?: string;
    readonly pngIconPath?: Option.Option<string>;
    readonly savedAppIcon?: string;
  } = {},
) => {
  const calls: ElectronAppCalls = input.calls ?? {
    setAboutPanelOptions: [],
    setDockIcon: [],
    setName: [],
  };

  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provide(NodePath.layerPosix),
        Layer.provideMerge(
          DesktopClientSettings.layerTest(
            input.savedAppIcon === undefined
              ? Option.none()
              : Option.some({ ...DEFAULT_CLIENT_SETTINGS, appIcon: input.savedAppIcon }),
          ),
        ),
        Layer.provideMerge(layerAssets(input.pngIconPath ?? Option.none())),
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: (path) =>
              input.legacyPathProbeError
                ? Effect.fail(input.legacyPathProbeError)
                : Effect.succeed(
                    path.includes("/app-icons/") ||
                      (input.legacyPathExists === true && /T3 Code \((Alpha|Dev)\)/.test(path)),
                  ),
            readFileString: () =>
              Effect.succeed(input.packageJson ?? '{"t3codeCommitHash":"abcdef1234567890"}'),
          }),
        ),
        Layer.provideMerge(layerElectronApp(calls)),
        Layer.provideMerge(layerEnvironment(input.environment)),
      ),
    ),
  );
};

describe("DesktopAppIdentity", () => {
  it.effect("isolates the V2 profile even when the legacy V1 profile exists", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;

        assert.equal(userDataPath, "/Users/alice/Library/Application Support/t3code-v2");
      }),
      { legacyPathExists: true },
    ),
  );

  it.effect("keeps using the legacy development profile", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        assert.equal(
          yield* identity.resolveUserDataPath,
          "/Users/alice/Library/Application Support/T3 Code (Dev)",
        );
      }),
      {
        legacyPathExists: true,
        environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
      },
    ),
  );

  it.effect.each([
    { stage: "Beta", environment: {} },
    {
      stage: "Nightly",
      environment: { appVersion: "0.0.43-nightly.20260929.2428" },
    },
    {
      stage: "Dev",
      environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
    },
  ])("uses a valid native User-Agent product name for $stage", ({ stage, environment }) => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        const runtimeName = calls.setName[0];
        assert.isDefined(runtimeName);
        assert.equal(runtimeName, `T3 Code ${stage}`);
        assert.match(runtimeName.replaceAll(" ", ""), /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, `T3 Code (${stage})`);
      }),
      { calls, environment },
    );
  });

  const PACKAGED_MAC_ICONS =
    "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist/client/app-icons";

  it.effect.each([
    {
      name: "a saved icon",
      savedAppIcon: "classic-blueprint",
      dock: [`${PACKAGED_MAC_ICONS}/classic-blueprint-macos.png`],
    },
    { name: "Default", savedAppIcon: "default", dock: [] },
    { name: "an unknown icon", savedAppIcon: "retired-icon", dock: [] },
    { name: "no saved settings", savedAppIcon: undefined, dock: [] },
  ])("sets the packaged macOS Dock icon on launch only for $name", ({ savedAppIcon, dock }) => {
    const calls: ElectronAppCalls = { setAboutPanelOptions: [], setDockIcon: [], setName: [] };
    return withIdentity(
      Effect.gen(function* () {
        yield* (yield* DesktopAppIdentity.DesktopAppIdentity).configure;
        assert.deepStrictEqual(calls.setDockIcon, dock);
      }),
      { calls, ...(savedAppIcon === undefined ? {} : { savedAppIcon }) },
    );
  });

  it.effect("restores the bundle's Dock icon when switching back to Default", () => {
    const calls: ElectronAppCalls = { setAboutPanelOptions: [], setDockIcon: [], setName: [] };
    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.applyAppIcon("default");
        yield* identity.applyAppIcon("sunrise");
        yield* identity.applyAppIcon("default");
        yield* identity.applyAppIcon("default");
        assert.deepStrictEqual(calls.setDockIcon, [
          `${PACKAGED_MAC_ICONS}/sunrise-macos.png`,
          null,
        ]);
      }),
      { calls },
    );
  });

  it.effect("keeps the development Dock icon for Default", () => {
    const calls: ElectronAppCalls = { setAboutPanelOptions: [], setDockIcon: [], setName: [] };
    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.applyAppIcon("black");
        yield* identity.applyAppIcon("default");
        assert.deepStrictEqual(calls.setDockIcon, [
          "/repo/apps/web/public/app-icons/black-macos.png",
          "/repo/assets/dev/blueprint-macos-1024.png",
        ]);
      }),
      {
        calls,
        environment: { isPackaged: false },
        pngIconPath: Option.some("/repo/assets/dev/blueprint-macos-1024.png"),
      },
    );
  });

  it.effect("swaps the Linux window icon and restores the build icon", () => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
      setWindowIcons: [],
    };
    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.applyAppIcon("classic-dev");
        yield* identity.applyAppIcon("default");
        assert.deepStrictEqual(calls.setDockIcon, []);
        assert.deepStrictEqual(calls.setWindowIcons, [
          "/opt/T3 Code/resources/app.asar/apps/server/dist/client/app-icons/classic-dev.png",
          "/opt/T3 Code/resources/app.asar/apps/desktop/resources/icon.png",
        ]);
      }),
      {
        calls,
        environment: {
          platform: "linux",
          appPath: "/opt/T3 Code/resources/app.asar",
          resourcesPath: "/opt/T3 Code/resources",
        },
        pngIconPath: Option.some("/opt/T3 Code/resources/app.asar/apps/desktop/resources/icon.png"),
      },
    );
  });
});

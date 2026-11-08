import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { T3_LEARN_APP_ID } from "@t3tools/shared/t3LearnIdentity";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/OminaX.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/OminaX.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>;
};

interface ElectronAppCalls {
  readonly setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions>;
  readonly setAppUserModelId: string[];
  readonly setAsDefaultProtocolClient: string[];
  readonly setDockIcon: string[];
  readonly setName: string[];
}

const layerElectronApp = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("OminaX"),
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
    setAppUserModelId: (id) =>
      Effect.sync(() => {
        calls.setAppUserModelId.push(id);
      }),
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: (protocol) =>
      Effect.sync(() => {
        calls.setAsDefaultProtocolClient.push(protocol);
        return true;
      }),
    setDesktopName: () => Effect.void,
    setDockIcon: (iconPath) =>
      Effect.sync(() => {
        calls.setDockIcon.push(iconPath);
      }),
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

const layerAssets = (png: Option.Option<string>) =>
  Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.none(),
      icns: Option.none(),
      png,
    }),
    resolveResourcePath: () => Effect.succeedNone,
  } satisfies DesktopAssets.DesktopAssets["Service"]);

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
    readonly probedPaths?: string[];
  } = {},
) => {
  const calls: ElectronAppCalls = input.calls ?? {
    setAboutPanelOptions: [],
    setAppUserModelId: [],
    setAsDefaultProtocolClient: [],
    setDockIcon: [],
    setName: [],
  };

  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provide(NodePath.layerPosix),
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: (path) => {
              input.probedPaths?.push(path);
              return input.legacyPathProbeError
                ? Effect.fail(input.legacyPathProbeError)
                : Effect.succeed(
                    input.legacyPathExists === true &&
                      /T3 Code \((Alpha|Dev)\)|t3code(-v2)?$/.test(path),
                  );
            },
            readFileString: () =>
              Effect.succeed(input.packageJson ?? '{"t3codeCommitHash":"abcdef1234567890"}'),
          }),
        ),
        Layer.provideMerge(layerAssets(input.pngIconPath ?? Option.none())),
        Layer.provideMerge(layerElectronApp(calls)),
        Layer.provideMerge(layerEnvironment(input.environment)),
      ),
    ),
  );
};

describe("DesktopAppIdentity", () => {
  it.effect.each([
    {
      platform: "darwin",
      environment: {},
      userDataPath: "/Users/alice/Library/Application Support/ominax",
    },
    {
      platform: "win32",
      environment: { platform: "win32", env: { APPDATA: "/Users/alice/AppData/Roaming" } },
      userDataPath: "/Users/alice/AppData/Roaming/ominax",
    },
  ] as const)(
    "uses its own $platform profile without reading T3 Code's profiles",
    ({ environment, userDataPath }) => {
      const probedPaths: string[] = [];
      return withIdentity(
        Effect.gen(function* () {
          const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
          assert.equal(yield* identity.resolveUserDataPath, userDataPath);
          assert.deepEqual(probedPaths, []);
        }),
        { environment, legacyPathExists: true, probedPaths },
      );
    },
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
      setAppUserModelId: [],
      setAsDefaultProtocolClient: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        const runtimeName = calls.setName[0];
        assert.isDefined(runtimeName);
        assert.equal(runtimeName, `OminaX ${stage}`);
        assert.match(runtimeName.replaceAll(" ", ""), /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, `OminaX (${stage})`);
      }),
      { calls, environment },
    );
  });

  it.effect("uses the OminaX app-user-model identity on Windows", () => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setAppUserModelId: [],
      setAsDefaultProtocolClient: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        assert.deepEqual(calls.setAppUserModelId, [T3_LEARN_APP_ID]);
        assert.deepEqual(calls.setAsDefaultProtocolClient, ["ominax", "t3learn"]);
        assert.equal(calls.setName[0], "OminaX Beta");
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "OminaX (Beta)");
      }),
      { calls, environment: { platform: "win32" } },
    );
  });
});

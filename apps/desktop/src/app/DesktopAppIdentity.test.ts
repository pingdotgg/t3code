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
  readonly setDockIcon: string[];
  readonly setName: string[];
}

const makeElectronAppLayer = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    whenReady: Effect.void,
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
    requestSingleInstanceLock: Effect.succeed(true),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: (iconPath) =>
      Effect.sync(() => {
        calls.setDockIcon.push(iconPath);
      }),
    appendCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

const makeAssetsLayer = (png: Option.Option<string>) =>
  Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.none(),
      icns: Option.none(),
      png,
    }),
    resolveResourcePath: () => Effect.succeed(Option.none()),
  } satisfies DesktopAssets.DesktopAssets["Service"]);

const makeEnvironmentLayer = (overrides: TestEnvironmentInput = {}) => {
  const { env, ...environmentOverrides } = overrides;
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
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
    readonly existingUserDataPaths?: readonly string[];
    readonly pathProbeError?: PlatformError.PlatformError;
    readonly packageJson?: string;
    readonly pngIconPath?: Option.Option<string>;
    readonly renamedPaths?: Array<{ readonly from: string; readonly to: string }>;
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
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: (path) =>
              input.pathProbeError
                ? Effect.fail(input.pathProbeError)
                : Effect.succeed(input.existingUserDataPaths?.includes(path) === true),
            readFileString: () =>
              Effect.succeed(input.packageJson ?? '{"t3codeCommitHash":"abcdef1234567890"}'),
            rename: (from, to) =>
              Effect.sync(() => {
                input.renamedPaths?.push({ from, to });
              }),
          }),
        ),
        Layer.provideMerge(makeAssetsLayer(input.pngIconPath ?? Option.none())),
        Layer.provideMerge(makeElectronAppLayer(calls)),
        Layer.provideMerge(makeEnvironmentLayer(input.environment)),
      ),
    ),
  );
};

describe("DesktopAppIdentity", () => {
  it.effect("keeps the canonical userData path when canonical and legacy paths both exist", () => {
    const renamedPaths: Array<{ readonly from: string; readonly to: string }> = [];

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;

        assert.equal(userDataPath, "/Users/alice/Library/Application Support/t3code");
        assert.deepEqual(renamedPaths, []);
      }),
      {
        existingUserDataPaths: [
          "/Users/alice/Library/Application Support/t3code",
          "/Users/alice/Library/Application Support/T3 Code (Alpha)",
        ],
        renamedPaths,
      },
    );
  });

  it.effect("migrates the stage-matched legacy userData path into the canonical path", () => {
    const renamedPaths: Array<{ readonly from: string; readonly to: string }> = [];
    const legacyPath = "/Users/alice/Library/Application Support/T3 Code (Alpha)";
    const canonicalPath = "/Users/alice/Library/Application Support/t3code";

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;

        assert.equal(userDataPath, canonicalPath);
        assert.deepEqual(renamedPaths, [{ from: legacyPath, to: canonicalPath }]);
      }),
      {
        existingUserDataPaths: [legacyPath],
        renamedPaths,
      },
    );
  });

  it.effect("uses the Nightly legacy path only for Nightly builds", () => {
    const renamedPaths: Array<{ readonly from: string; readonly to: string }> = [];
    const legacyPath = "/Users/alice/Library/Application Support/T3 Code (Nightly)";
    const canonicalPath = "/Users/alice/Library/Application Support/t3code";

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;

        assert.equal(userDataPath, canonicalPath);
        assert.deepEqual(renamedPaths, [{ from: legacyPath, to: canonicalPath }]);
      }),
      {
        environment: {
          appVersion: "0.0.29-nightly.20260723.864",
        },
        existingUserDataPaths: [
          "/Users/alice/Library/Application Support/T3 Code (Alpha)",
          legacyPath,
        ],
        renamedPaths,
      },
    );
  });

  it.effect("preserves failures while inspecting the canonical userData path", () => {
    const canonicalPath = "/Users/alice/Library/Application Support/t3code";
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists",
      description: "permission denied",
      pathOrDescriptor: canonicalPath,
    });

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const error = yield* identity.resolveUserDataPath.pipe(Effect.flip);

        assert.instanceOf(error, DesktopAppIdentity.DesktopUserDataPathResolutionError);
        assert.equal(error.operation, "inspect-path");
        assert.equal(error.path, canonicalPath);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          `Failed to inspect desktop user-data path at "${canonicalPath}".`,
        );
      }),
      { pathProbeError: cause },
    );
  });

  it.effect("configures app identity from the environment commit override", () => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        assert.deepEqual(calls.setName, ["T3 Code (Alpha)"]);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "T3 Code (Alpha)");
        assert.equal(calls.setAboutPanelOptions[0]?.applicationVersion, "1.2.3");
        assert.equal(calls.setAboutPanelOptions[0]?.version, "0123456789ab");
        assert.deepEqual(calls.setDockIcon, ["/icon.png"]);
      }),
      {
        calls,
        environment: {
          env: {
            T3CODE_COMMIT_HASH: "0123456789abcdef",
          },
        },
        pngIconPath: Option.some("/icon.png"),
      },
    );
  });
});

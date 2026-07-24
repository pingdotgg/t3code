import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: " /tmp/t3 ",
          T3CODE_COMMIT_HASH: " 0123456789abcdef ",
          T3CODE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          T3CODE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          T3CODE_OTLP_EXPORT_INTERVAL_MS: "2500",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assert.equal(environment.baseDir, "/tmp/t3");
      assert.equal(environment.stateDir, "/tmp/t3/userdata");
      assert.equal(environment.desktopSettingsPath, "/tmp/t3/userdata/desktop-settings.json");
      assert.equal(environment.clientSettingsPath, "/tmp/t3/userdata/client-settings.json");
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        "/tmp/t3/userdata/saved-environments.json",
      );
      assert.equal(environment.serverSettingsPath, "/tmp/t3/userdata/settings.json");
      assert.equal(environment.logDir, "/tmp/t3/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/t3/userdata/browser-artifacts");
      assert.equal(environment.rootDir, "/repo");
      assert.equal(environment.appRoot, "/repo");
      assert.equal(environment.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assert.equal(environment.backendCwd, "/repo");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code.dev");
      assert.equal(environment.linuxWmClass, "t3code-dev");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(environment.devRemoteT3ServerEntryPath, Option.some("/remote/server.mjs"));
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
    }),
  );

  it.effect("stores production state under userdata in an explicit home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: "/tmp/t3",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, "/tmp/t3/userdata");
      assert.equal(environment.logDir, "/tmp/t3/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/t3/userdata/browser-artifacts");
      assert.equal(environment.serverSettingsPath, "/tmp/t3/userdata/settings.json");
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(
        development.stateDir,
        "/Users/alice/Library/Application Support/t3code-dev/state",
      );
      assert.equal(production.stateDir, "/Users/alice/Library/Application Support/t3code/state");
      assert.equal(production.configDir, "/Users/alice/Library/Application Support/t3code/config");
      assert.equal(production.dataDir, "/Users/alice/Library/Application Support/t3code/data");
      assert.equal(production.cacheDir, "/Users/alice/Library/Caches/t3code");
      assert.equal(production.runtimeDir, "/tmp/t3code");
    }),
  );

  it.effect("honors all five XDG roots on Linux", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {
          platform: "linux",
          homeDirectory: "/home/alice",
          temporaryDirectory: "/tmp",
          userId: 1000,
        },
        {
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_DATA_HOME: "/xdg/data",
          XDG_STATE_HOME: "/xdg/state",
          XDG_CACHE_HOME: "/xdg/cache",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
      );

      assert.equal(environment.storageLayout, "split");
      assert.equal(environment.configDir, "/xdg/config/t3code");
      assert.equal(environment.dataDir, "/xdg/data/t3code");
      assert.equal(environment.stateDir, "/xdg/state/t3code");
      assert.equal(environment.cacheDir, "/xdg/cache/t3code");
      assert.equal(environment.runtimeDir, "/run/user/1000/t3code");
      assert.equal(environment.serverSettingsPath, "/xdg/config/t3code/settings.json");
      assert.equal(environment.browserArtifactsDir, "/xdg/cache/t3code/browser-artifacts");
      assert.equal(environment.electronUserDataPath, "/xdg/state/t3code/electron");
    }),
  );

  it.effect("rejects mixing T3CODE_HOME with granular directory overrides", () =>
    Effect.gen(function* () {
      const error = yield* makeEnvironment(
        { platform: "linux", homeDirectory: "/home/alice" },
        {
          T3CODE_HOME: "/tmp/legacy-t3",
          T3CODE_STATE_DIR: "/tmp/t3-state",
        },
      ).pipe(Effect.flip);

      assert.instanceOf(
        error,
        DesktopEnvironment.DesktopStorageDirectoryConfigurationConflictError,
      );
    }),
  );

  it.effect("keeps an initialized legacy installation without copying it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-environment-legacy-",
      });
      const homeDirectory = path.join(root, "home");
      const legacyStateDir = path.join(homeDirectory, ".t3", "userdata");
      const splitStateHome = path.join(root, "state");
      yield* fileSystem.makeDirectory(legacyStateDir, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(splitStateHome, "t3code"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(legacyStateDir, "state.sqlite"), "legacy");
      yield* fileSystem.writeFileString(path.join(splitStateHome, "t3code", "state.sqlite"), "");

      const environment = yield* makeEnvironment(
        {
          platform: "linux",
          homeDirectory,
          temporaryDirectory: root,
          userId: 1000,
        },
        { XDG_STATE_HOME: splitStateHome },
      );

      assert.equal(environment.storageLayout, "legacy");
      assert.equal(environment.stateDir, legacyStateDir);
      assert.equal(environment.serverSettingsPath, path.join(legacyStateDir, "settings.json"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a configured app user model id override", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_DESKTOP_APP_USER_MODEL_ID: " com.t3tools.t3code.dev.local ",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );

      assert.equal(environment.appUserModelId, "com.t3tools.t3code.dev.local");
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});

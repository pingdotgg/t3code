import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
  windowsProcessorArchitectures: [],
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
      assert.equal(environment.stateDir, "/tmp/t3/dev");
      assert.equal(environment.desktopSettingsPath, "/tmp/t3/dev/desktop-settings.json");
      assert.equal(environment.clientSettingsPath, "/tmp/t3/dev/client-settings.json");
      assert.equal(environment.savedEnvironmentRegistryPath, "/tmp/t3/dev/saved-environments.json");
      assert.equal(environment.serverSettingsPath, "/tmp/t3/dev/settings.json");
      assert.equal(environment.logDir, "/tmp/t3/dev/logs");
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

  it.effect("derives production state paths under userdata", () =>
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
      assert.equal(environment.serverSettingsPath, "/tmp/t3/userdata/settings.json");
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

  it.effect("detects macOS arm64 host running x64 build under Rosetta", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "darwin",
        processArch: "x64",
        runningUnderArm64Translation: true,
      });

      assert.deepEqual(environment.runtimeInfo, {
        hostArch: "arm64",
        appArch: "x64",
        runningUnderArm64Translation: true,
      });
    }),
  );

  it.effect("detects Windows arm64 host via PROCESSOR_ARCHITECTURE env var", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        processArch: "x64",
        runningUnderArm64Translation: false,
        windowsProcessorArchitectures: ["ARM64"],
      });

      assert.deepEqual(environment.runtimeInfo, {
        hostArch: "arm64",
        appArch: "x64",
        runningUnderArm64Translation: true,
      });
    }),
  );

  it.effect("detects Windows arm64 host via PROCESSOR_ARCHITEW6432 env var", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        processArch: "x64",
        runningUnderArm64Translation: false,
        windowsProcessorArchitectures: ["AMD64", "ARM64"],
      });

      assert.deepEqual(environment.runtimeInfo, {
        hostArch: "arm64",
        appArch: "x64",
        runningUnderArm64Translation: true,
      });
    }),
  );

  it.effect("reports x64 host on Windows x64 with x64 process", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        processArch: "x64",
        runningUnderArm64Translation: false,
        windowsProcessorArchitectures: ["AMD64"],
      });

      assert.deepEqual(environment.runtimeInfo, {
        hostArch: "x64",
        appArch: "x64",
        runningUnderArm64Translation: false,
      });
    }),
  );

  it.effect("reports arm64 host and app on Windows arm64 native build", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        processArch: "arm64",
        runningUnderArm64Translation: false,
        windowsProcessorArchitectures: ["ARM64"],
      });

      assert.deepEqual(environment.runtimeInfo, {
        hostArch: "arm64",
        appArch: "arm64",
        runningUnderArm64Translation: false,
      });
    }),
  );

  it.effect("reports no ARM64 translation on Linux", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "linux",
        processArch: "x64",
        runningUnderArm64Translation: false,
        windowsProcessorArchitectures: [],
      });

      assert.deepEqual(environment.runtimeInfo, {
        hostArch: "x64",
        appArch: "x64",
        runningUnderArm64Translation: false,
      });
    }),
  );
});

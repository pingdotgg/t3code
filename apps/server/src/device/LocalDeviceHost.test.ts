import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessIsExecutable,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

const diagnose = (
  files: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
  );

describe("Android SDK availability", () => {
  it.effect("explains that adb alone is insufficient to launch an emulator", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb"], { ANDROID_HOME: "/sdk" });
      expect(reason).toContain("Android Emulator is missing");
    }),
  );

  it.effect("identifies command-line tools required by the device hub", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb", "/sdk/emulator/emulator"], {
        ANDROID_HOME: "/sdk",
      });
      expect(reason).toContain("Command-line Tools (latest) are missing");
    }),
  );

  it.effect("explains how to upgrade legacy command-line tools in the standard macOS SDK", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/tools/bin/avdmanager`],
        { HOME: "/test/home" },
      );
      expect(reason).toContain("older, unsupported version");
      expect(reason).toContain(root);
      expect(reason).toContain(
        "Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.",
      );
    }),
  );

  it.effect("recognizes legacy command-line tools on Windows", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "C:\\Android\\Sdk\\platform-tools\\adb.exe",
          "C:\\Android\\Sdk\\emulator\\emulator.exe",
          "C:\\Android\\Sdk\\tools\\bin\\avdmanager.bat",
        ],
        { ANDROID_HOME: "C:\\Android\\Sdk" },
        "win32",
      );
      expect(reason).toContain("older, unsupported version");
    }),
  );

  it.effect("accepts the latest command-line tools when legacy tools are also installed", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "/sdk/platform-tools/adb",
          "/sdk/emulator/emulator",
          "/sdk/tools/bin/avdmanager",
          "/sdk/cmdline-tools/latest/bin/avdmanager",
        ],
        { ANDROID_HOME: "/sdk" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("discovers the standard macOS SDK without ANDROID_HOME", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [
          `${root}/platform-tools/adb`,
          `${root}/emulator/emulator`,
          `${root}/cmdline-tools/latest/bin/avdmanager`,
        ],
        { HOME: "/test/home" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("reports an absent SDK without running or installing tools", () =>
    Effect.gen(function* () {
      expect(yield* diagnose([], { HOME: "/test/home" })).toContain("Android SDK was not found");
    }),
  );
});

it.effect("puts detected Android tools on the helper PATH without losing existing commands", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const environment = LocalDeviceHost.__testing.deviceHostEnvironment(
      { PATH: "/usr/bin", HOME: "/test/home" },
      "/sdk",
      "darwin",
      path,
    );
    expect(environment.PATH).toBe("/sdk/platform-tools:/sdk/emulator:/usr/bin");
    expect(environment.ANDROID_HOME).toBe("/sdk");
    expect(environment.HOME).toBe("/test/home");
  }).pipe(Effect.provide(NodePath.layer)),
);

it.effect(
  "constructs and inspects an unconfigured host without installing or starting helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-consent-" });
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("Host construction must not spawn processes")),
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die(new Error("Host construction must not run commands")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("Host construction must not make network requests")),
          ),
        ),
      );
      expect(yield* host.current).toBeNull();
      const error = yield* host
        .ensureReady(() => Effect.die("Must not install without Node"))
        .pipe(Effect.flip, Effect.provideService(HostProcessIsExecutable, true));
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

describe("host spawn targets", () => {
  const SDK_ROOT = "/test/home/Library/Android/sdk";
  const sdkFiles = (root: string) => [
    `${root}/platform-tools/adb`,
    `${root}/emulator/emulator`,
    `${root}/cmdline-tools/latest/bin/avdmanager`,
  ];
  const spawnTarget = (command: string, files: ReadonlySet<string>) =>
    LocalDeviceHost.__testing
      .hostSpawn(command)
      .pipe(
        Effect.provideService(HostProcessEnvironment, { HOME: "/test/home", PATH: "" }),
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ exists: (file) => Effect.succeed(files.has(file)) }),
        ),
        Effect.provide(NodePath.layer),
      );

  it.effect("spawns the emulator by absolute path so it need not be on PATH", () =>
    Effect.gen(function* () {
      const target = yield* spawnTarget("emulator", new Set(sdkFiles(SDK_ROOT)));
      expect(target.command).toBe(`${SDK_ROOT}/emulator/emulator`);
      expect(target.env.ANDROID_HOME).toBe(SDK_ROOT);
    }),
  );

  it.effect("preserves PATH lookup when the detected SDK has adb but no emulator", () =>
    Effect.gen(function* () {
      const target = yield* spawnTarget("emulator", new Set([`${SDK_ROOT}/platform-tools/adb`]));
      expect(target.command).toBe("emulator");
      expect(target.env.ANDROID_HOME).toBe(SDK_ROOT);
    }),
  );

  it.effect("leaves commands other than the emulator alone", () =>
    Effect.gen(function* () {
      const target = yield* spawnTarget("xcrun", new Set(sdkFiles(SDK_ROOT)));
      expect(target.command).toBe("xcrun");
    }),
  );

  it.effect("picks up an SDK installed after an earlier spawn resolved nothing", () =>
    Effect.gen(function* () {
      // Availability re-resolves on every check, so spawns have to as well.
      // Caching the location meant an SDK that appeared after startup left the
      // two disagreeing: Android reported available while the spawn fell back
      // to a bare `emulator`, failing the whole device list with exit code 127.
      const files = new Set<string>();
      expect((yield* spawnTarget("emulator", files)).command).toBe("emulator");
      for (const file of sdkFiles(SDK_ROOT)) files.add(file);
      const refreshed = yield* spawnTarget("emulator", files);
      expect(refreshed.command).toBe(`${SDK_ROOT}/emulator/emulator`);
      expect(refreshed.env.ANDROID_HOME).toBe(SDK_ROOT);
      expect(refreshed.env.PATH).toBe(`${SDK_ROOT}/platform-tools:${SDK_ROOT}/emulator:`);
    }),
  );
});

it.effect("retains the host environment after construction while refreshing the SDK", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-environment-" });
    const bin = `${home}/bin`;
    const nodePath = `${bin}/node`;
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(nodePath, "fixture");
    yield* fs.chmod(nodePath, 0o755);
    for (const [name, version, entry] of [
      ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
      ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
    ] as const) {
      const installDir = `${home}/tools/${name}/${version}`;
      const entryPath = `${installDir}/node_modules/${name}/${entry}`;
      yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fs.writeFileString(entryPath, "fixture");
      yield* fs.writeFileString(`${installDir}/.install-complete`, version);
    }
    const runs: ProcessRunner.ProcessRunInput[] = [];
    const hubEnvironments: NodeJS.ProcessEnv[] = [];
    const host = yield* LocalDeviceHost.make().pipe(
      Effect.provide(ServerConfig.layerTest(home, home)),
      Effect.provideService(HostProcessEnvironment, { HOME: home, PATH: bin }),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(NetService.NetService, {
        ...NetService.make(),
        reserveLoopbackPort: () => Effect.succeed(1234),
      }),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
            expect(command.command).toBe(nodePath);
            hubEnvironments.push(command.options.env ?? {});
            const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            const stop = Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(
              Effect.asVoid,
            );
            yield* Effect.addFinalizer(() => stop);
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Deferred.await(exit),
              isRunning: Effect.succeed(true),
              kill: () => stop,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
        ),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            runs.push(input);
            if (input.args.includes("devices")) {
              const stateDir = input.env?.AGENT_DEVICE_STATE_DIR;
              if (!stateDir) return yield* Effect.die("Missing daemon state directory");
              yield* fs
                .writeFileString(`${stateDir}/daemon.json`, '{"httpPort":1235,"token":"fixture"}')
                .pipe(Effect.orDie);
            }
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
        ),
      ),
    );
    // Returned methods run outside the environment provided only to make().
    const ready = yield* host.ensureReady(() => Effect.void);
    expect(hubEnvironments[0]).toMatchObject({ HOME: home, PATH: bin });
    const root = `${home}/Android/Sdk`;
    for (const tool of [
      "platform-tools/adb",
      "emulator/emulator",
      "cmdline-tools/latest/bin/avdmanager",
    ]) {
      const file = `${root}/${tool}`;
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, "fixture");
    }
    expect((yield* host.platformAvailability("android")).available).toBe(true);
    expect((yield* host.platformAvailability("ios")).available).toBe(false);
    yield* ready.run("emulator", ["-list-avds"]);
    const emulator = runs.find((input) => input.args.includes("-list-avds"));
    expect(emulator?.command).toBe(`${root}/emulator/emulator`);
    const environment = {
      HOME: home,
      ANDROID_HOME: root,
      PATH: `${root}/platform-tools:${root}/emulator:${bin}`,
    };
    expect(emulator?.env).toMatchObject(environment);
    yield* host.ensureAgentReady(() => Effect.void);
    expect(runs.find((input) => input.args.includes("devices"))?.env).toMatchObject(environment);
    yield* host.stop;
    expect(runs.find((input) => input.args.includes("stop"))?.env).toMatchObject(environment);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessIsExecutable, true),
    Effect.provideService(HostProcessEnvironment, { HOME: "/other/home", PATH: "" }),
    Effect.provideService(HostProcessPlatform, "win32"),
  ),
);

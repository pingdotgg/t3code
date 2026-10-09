import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessIsExecutable,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import {
  agentDeviceConfigPath,
  retireLegacyAgentDeviceConfig,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  agentDeviceStateDir,
} from "./DeviceToolchain.ts";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

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
  "recovers an owned Linux runtime directory without overriding explicit environments",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const stat = yield* fs.stat(directory);
      for (const [platform, uid, runtimeDir, type, owner, expected] of [
        ["linux", 1000, undefined, "Directory", 1000, "/run/user/1000"],
        ["linux", 1000, "/custom/runtime", "Directory", 1000, "/custom/runtime"],
        ["linux", 1000, "", "Directory", 1000, ""],
        ["linux", 1000, undefined, "Directory", 1001, undefined],
        ["linux", 1000, undefined, "File", 1000, undefined],
        ["linux", undefined, undefined, "Directory", 1000, undefined],
        ["darwin", 1000, undefined, "Directory", 1000, undefined],
        ["win32", 1000, undefined, "Directory", 1000, undefined],
      ] as const) {
        const environment = { PATH: "/usr/bin", XDG_RUNTIME_DIR: runtimeDir };
        const result = yield* LocalDeviceHost.__testing.hubEnvironment(environment).pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(HostProcessUserId, uid),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              stat: (path) => {
                expect(path).toBe("/run/user/1000");
                return Effect.succeed({ ...stat, type, uid: Option.some(owner) });
              },
            }),
          ),
        );
        expect(result.XDG_RUNTIME_DIR).toBe(expected);
        expect(result.PATH).toBe("/usr/bin");
        expect(result.FORCE_COLOR).toBe("0");
        expect(result.NO_COLOR).toBe("1");
        expect(environment.XDG_RUNTIME_DIR).toBe(runtimeDir);
      }
      const missing = yield* LocalDeviceHost.__testing
        .hubEnvironment({})
        .pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessUserId, 1000),
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        );
      expect(missing.XDG_RUNTIME_DIR).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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

it.effect.each([true, false, "activation"] as const)(
  "invalidates a recovered daemon before use (stop succeeds or activation: %s)",
  (scenario) =>
    Effect.gen(function* () {
      const stopSucceeds = scenario !== false;
      const retireFirst = scenario !== "activation";
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-recovered-agent-" });
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(directory, directory)),
      );
      for (const [name, version, entry] of [
        ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
        ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
        ["agent-device", "0.0.1", "bin/agent-device.mjs"],
      ]) {
        const install = path.join(config.baseDir, "tools", name!, version!);
        const file = path.join(install, "node_modules", name!, entry!);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
        yield* fs.writeFileString(path.join(install, ".install-complete"), version!);
      }
      const state = agentDeviceStateDir(path, config.stateDir);
      const daemonFile = path.join(state, "daemon.json");
      yield* fs.makeDirectory(state, { recursive: true });
      yield* fs.writeFileString(
        daemonFile,
        JSON.stringify({ httpPort: 1234, token: "old-raw-token", version: "0.0.1" }),
      );
      const commands: string[] = [];
      let rawCredentialAccepted = true;
      const runner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.gen(function* () {
            if (input.args[1] === "daemon") {
              expect(input.args[0]).toBe(
                path.join(
                  config.baseDir,
                  `tools/agent-device/${commands.includes("devices") ? AGENT_DEVICE_VERSION : "0.0.1"}/node_modules/agent-device/bin/agent-device.mjs`,
                ),
              );
              commands.push("stop");
              if (stopSucceeds) {
                rawCredentialAccepted = false;
                yield* fs.remove(daemonFile, { force: true });
              }
            } else if (input.args[1] === "devices") {
              commands.push("devices");
              yield* fs.writeFileString(
                daemonFile,
                JSON.stringify({ httpPort: 2345, token: "current-raw-token" }),
              );
            }
            return {
              code: ChildProcessSpawner.ExitCode(
                input.args[1] === "daemon" && !stopSucceeds ? 1 : 0,
              ),
              stdout: "",
              stderr: "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      };
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(123),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      );
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provide(NetService.layer),
        Effect.provideService(HostProcessEnvironment, { HOME: directory, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
          ),
        ),
      );
      // Revocation can run before consent or helper activation; it must not start anything.
      const retired = retireFirst ? yield* host.stopAgent.pipe(Effect.result) : null;
      if (!stopSucceeds) {
        expect(retired?._tag).toBe("Failure");
        expect(rawCredentialAccepted).toBe(true);
        expect(commands).toEqual(["stop"]);
        expect(yield* fs.exists(daemonFile)).toBe(true);
        return;
      }
      if (retireFirst) {
        expect(rawCredentialAccepted).toBe(false);
        expect(commands).toEqual(["stop"]);
      }
      const first = yield* host.ensureAgentReady(() => Effect.void);
      const reused = yield* host.ensureAgentReady(() => Effect.void);
      expect(rawCredentialAccepted).toBe(false);
      expect(first.agentDevice.token).toBe("current-raw-token");
      expect(reused.agentDevice).toEqual(first.agentDevice);
      expect(commands).toEqual(["stop", "devices"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { launcher: false, state: "dead", succeeds: true },
  { launcher: false, state: "alive", succeeds: false },
  { launcher: false, state: "unknown", succeeds: false },
  { launcher: false, state: "missing", succeeds: true },
  { launcher: false, state: "invalidJson", succeeds: false },
  { launcher: false, state: "invalidSchema", succeeds: false },
  { launcher: false, state: "unreadable", succeeds: false },
  { launcher: true, state: "deadAfterStop", succeeds: true },
  { launcher: true, state: "alive", succeeds: false },
  { launcher: true, state: "alive", succeeds: true },
  { launcher: true, state: "alive", succeeds: false, version: "../0.0.1" },
  { launcher: true, state: "alive", succeeds: false, version: "garbage" },
  { launcher: true, state: "alive", succeeds: false, sentinel: "wrong" },
  { launcher: true, state: "alive", succeeds: false, sentinel: null },
])(
  "retires stale recovered daemon state safely (%s)",
  ({ launcher, state, succeeds, version = "0.0.1", sentinel = "0.0.1" }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stale-agent-" });
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(directory, directory)),
      );
      // Use only a process captured by this test; no real daemon or arbitrary PID is stopped.
      const child =
        state !== "unknown" && state !== "missing"
          ? yield* spawner.spawn(
              ChildProcess.make(process.execPath, [
                "-e",
                state === "dead" ? "" : "setInterval(() => {}, 1000)",
              ]),
            )
          : undefined;
      if (state === "dead") yield* child!.exitCode.pipe(Effect.result);
      if (launcher) {
        const install = path.join(config.baseDir, "tools", "agent-device", "0.0.1");
        const entry = path.join(install, "node_modules", "agent-device", "bin/agent-device.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        if (sentinel !== null)
          yield* fs.writeFileString(path.join(install, ".install-complete"), sentinel);
      }
      const daemonFile = path.join(agentDeviceStateDir(path, config.stateDir), "daemon.json");
      yield* fs.makeDirectory(path.dirname(daemonFile), { recursive: true });
      if (state !== "missing")
        yield* fs.writeFileString(
          daemonFile,
          state === "invalidJson"
            ? '{"httpPort":1234,"token":"recovered-raw-token"'
            : JSON.stringify({
                httpPort: state === "invalidSchema" ? "invalid" : 1234,
                token: "recovered-raw-token",
                version,
                ...(state === "unknown" ? {} : { pid: child?.pid ?? process.pid }),
              }),
        );
      const commands: string[] = [];
      const runner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.gen(function* () {
            commands.push(input.args[1]!);
            expect(input.args[0]).toBe(
              path.join(
                config.baseDir,
                "tools/agent-device/0.0.1/node_modules/agent-device/bin/agent-device.mjs",
              ),
            );
            expect(input.command).toBe(process.execPath);
            expect(input.args.slice(1, 3)).toEqual(["daemon", "stop"]);
            if (state === "deadAfterStop") {
              yield* child!.kill();
              yield* child!.exitCode.pipe(Effect.result);
            }
            return {
              code: ChildProcessSpawner.ExitCode(succeeds && state === "alive" ? 0 : 1),
              stdout: "",
              stderr: "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      };
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, options) =>
            state === "unreadable" && file === daemonFile
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                    description: "denied",
                  }),
                )
              : fs.readFileString(file, options),
        }),
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provide(NetService.layer),
        Effect.provideService(HostProcessEnvironment, { HOME: directory, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Retirement must not start a helper")),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Retirement must not make network requests")),
        ),
      );
      const legacyFile = yield* agentDeviceConfigPath(config.stateDir, host.id, path);
      yield* writeAgentDeviceConfig(legacyFile, {
        baseUrl: "http://127.0.0.1:1234",
        token: "recovered-raw-token",
        entryPath: "unused",
      });
      const result = yield* retireLegacyAgentDeviceConfig(config.stateDir, host).pipe(
        Effect.result,
      );
      expect(yield* fs.exists(legacyFile)).toBe(!succeeds);
      expect(result._tag).toBe(succeeds ? "Success" : "Failure");
      expect(yield* fs.exists(daemonFile)).toBe(!succeeds);
      expect(commands).toEqual(
        launcher && state !== "dead" && version === "0.0.1" && sentinel === "0.0.1"
          ? ["daemon"]
          : [],
      );
      expect(
        yield* fs.exists(path.join(config.baseDir, "tools", "agent-device", AGENT_DEVICE_VERSION)),
      ).toBe(false);
      if (!launcher) expect(yield* fs.exists(path.join(config.baseDir, "tools"))).toBe(false);
      expect(yield* host.current).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

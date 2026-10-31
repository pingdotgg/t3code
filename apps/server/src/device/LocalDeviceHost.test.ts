import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  agentDeviceStateDir,
} from "./DeviceToolchain.ts";

const processOutput = (code: number, stdout = "", stderr = "", timedOut = false) => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr,
  timedOut,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const agentFixture = Effect.fn("agentFixture")(function* (
  startup: (
    stateDir: string,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  avdOutput: ProcessRunner.ProcessRunOutput = processOutput(0),
  systemAdb = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-agent-start-" });
  const hub = { running: true, spawnFails: false };
  const stateDir = agentDeviceStateDir(path, path.join(baseDir, "userdata"));
  const daemonHealthy = yield* Ref.make(true);
  const sdkRoot = path.join(baseDir, "sdk");
  const bin = path.join(baseDir, "bin");
  if (systemAdb) {
    for (const file of [
      path.join(sdkRoot, "emulator", "emulator"),
      path.join(sdkRoot, "cmdline-tools", "latest", "bin", "avdmanager"),
    ]) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, "");
    }
    yield* fs.makeDirectory(bin);
    yield* fs.symlink(process.execPath, path.join(bin, "adb"));
  }
  for (const [name, version, entry] of [
    ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
    ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
  ]) {
    const installDir = path.join(baseDir, "tools", name!, version!);
    const entryPath = path.join(installDir, "node_modules", name!, entry!);
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "");
    yield* fs.writeFileString(path.join(installDir, ".install-complete"), version!);
  }
  const host = yield* LocalDeviceHost.make().pipe(
    Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
    Effect.provideService(HostProcess.Environment, {
      HOME: baseDir,
      PATH: systemAdb ? bin : "",
      ...(systemAdb ? { ANDROID_HOME: sdkRoot } : {}),
    }),
    Effect.provideService(HostProcess.IsExecutable, false),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        hub.spawnFails
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                description: "Hub entry missing",
              }),
            )
          : Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(123),
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                exitCode: Effect.never,
                isRunning: Effect.sync(() => hub.running),
                kill: () => Effect.void,
                stdin: Sink.drain,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              }),
            ),
      ),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) =>
        input.args.includes("devices")
          ? startup(stateDir)
          : Effect.succeed(input.args.includes("-list-avds") ? avdOutput : processOutput(0)),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Ref.get(daemonHealthy).pipe(
          Effect.map((healthy) =>
            HttpClientResponse.fromWeb(
              request,
              new Response("ok", {
                status: request.url.endsWith("/health") && !healthy ? 503 : 200,
              }),
            ),
          ),
        ),
      ),
    ),
  );
  yield* host.ensureReady(() => Effect.void);
  return { host, fs, stateDir, hub, daemonHealthy };
});

describe("AgentDevice startup", () => {
  it.effect("restarts a cached daemon that no longer answers its health check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let attempts = 0;
      const { host, daemonHealthy } = yield* agentFixture((stateDir) =>
        Effect.gen(function* () {
          attempts++;
          yield* fs
            .writeFileString(
              `${stateDir}/daemon.json`,
              JSON.stringify({ httpPort: 12345 + attempts, token: `token-${attempts}` }),
            )
            .pipe(Effect.orDie);
          return processOutput(0);
        }),
      );
      const first = yield* host.ensureAgentReady(() => Effect.void);
      expect((yield* host.ensureAgentReady(() => Effect.void)).agentDevice).toEqual(
        first.agentDevice,
      );
      expect(attempts).toBe(1);

      yield* Ref.set(daemonHealthy, false);
      const restarted = yield* host.ensureAgentReady(() => Effect.void);
      expect(attempts).toBe(2);
      expect(restarted.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12347",
        token: "token-2",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an incompatible lock immediately and retains it for manual repair", () =>
    Effect.gen(function* () {
      const result = processOutput(
        1,
        JSON.stringify({
          success: false,
          error: {
            message: "private command output",
            details: {
              reason: "daemon_registration_unproven",
              inspection: { state: "unproven", reason: "non-directory" },
            },
          },
        }),
      );
      const { host, fs, stateDir } = yield* agentFixture(() => Effect.succeed(result));
      const lock = `${stateDir}/daemon.lock`;
      const legacyOwner = JSON.stringify({ pid: 85669, processStartTime: "old start time" });
      yield* fs.writeFileString(lock, legacyOwner);
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "daemon_lock_not_directory",
        exitCode: 1,
        cause: result,
      });
      expect(error.message).toContain("Daemon registration ownership could not be verified");
      expect(error.message).toContain("daemon.lock is not a directory");
      expect(error.message).toContain(stateDir);
      expect(error.message).toContain("original CLI");
      expect(error.message).not.toContain("private command output");
      expect(yield* fs.readFileString(lock)).toBe(legacyOwner);
      expect(yield* host.current).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unknown nonzero exits without exposing arbitrary command output", () =>
    Effect.gen(function* () {
      const result = processOutput(2, "invalid JSON", "private credentials");
      const { host, stateDir } = yield* agentFixture(() => Effect.succeed(result));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "command_failed",
        exitCode: 2,
        cause: result,
      });
      expect(error.message).toContain("exit code 2");
      expect(error.message).toContain(stateDir);
      expect(error.message).not.toContain("private credentials");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves process execution failures instead of waiting for a daemon file", () =>
    Effect.gen(function* () {
      const cause = new ProcessRunner.ProcessSpawnError({
        command: "/missing/node",
        argumentCount: 3,
        cause: new Error("missing executable"),
      });
      const { host } = yield* agentFixture(() => Effect.fail(cause));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceHostError",
        step: "starting agent tools",
        cause,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a registered daemon when reading startup command output fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cause = new ProcessRunner.ProcessReadError({
        command: process.execPath,
        argumentCount: 3,
        stream: "stdout",
        cause: new Error("output read failed after registration"),
      });
      let attempts = 0;
      const { host } = yield* agentFixture((stateDir) =>
        Effect.gen(function* () {
          attempts++;
          yield* fs
            .writeFileString(
              `${stateDir}/daemon.json`,
              JSON.stringify({ httpPort: 12345, token: "test-token" }),
            )
            .pipe(Effect.orDie);
          return yield* cause;
        }),
      );
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(ready.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12345",
        token: "test-token",
      });
      expect((yield* host.ensureAgentReady(() => Effect.void)).agentDevice).toEqual(
        ready.agentDevice,
      );
      expect((yield* host.current)?.releaseAgentSession).toBeTypeOf("function");
      expect(attempts).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps releasing agent sessions while a dead hub fails to restart and after", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { host, hub, stateDir } = yield* agentFixture(
        (stateDir) =>
          fs
            .writeFileString(
              `${stateDir}/daemon.json`,
              JSON.stringify({ httpPort: 12345, token: "test-token" }),
            )
            .pipe(Effect.orDie, Effect.as(processOutput(0))),
        processOutput(0),
        HostProcess.Platform.defaultValue() !== "win32",
      );
      yield* host.ensureAgentReady(() => Effect.void);
      const sdkViews = fs
        .readDirectory(stateDir)
        .pipe(Effect.map((entries) => entries.filter((entry) => entry.startsWith("android-sdk-"))));
      hub.running = false;
      hub.spawnFails = true;
      expect((yield* host.ensureReady(() => Effect.void).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* host.current)?.releaseAgentSession).toBeTypeOf("function");
      expect(yield* sdkViews).toEqual([]);
      hub.spawnFails = false;
      yield* host.ensureReady(() => Effect.void);
      expect((yield* host.current)?.releaseAgentSession).toBeTypeOf("function");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const diagnose = (
  files: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
  );

describe("Android SDK availability", () => {
  it.effect("uses the standard Windows SDK without probing PATH", () =>
    Effect.gen(function* () {
      const root = "C:\\Users\\test\\AppData\\Local\\Android\\Sdk";
      const probes: string[] = [];
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          USERPROFILE: "C:\\Users\\test",
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          PATH: "\\\\slow-share\\tools;C:\\other-tools",
        }),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) =>
              Effect.sync(() => {
                probes.push(file);
                return file === `${root}\\platform-tools\\adb.exe`;
              }),
            realPath: () => Effect.die("Standard SDK must not resolve PATH executables"),
          }),
        ),
        Effect.provide(NodePath.layerWin32),
      );
      expect(sdk).toMatchObject({ root, adb: true });
      expect(probes.filter((file) => !file.startsWith("C:\\Users\\test\\"))).toEqual([]);
    }),
  );

  it.effect("falls back to adb on the Windows Path without resolving missing entries", () =>
    Effect.gen(function* () {
      const root = "D:\\Android\\Sdk";
      const resolved: string[] = [];
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          USERPROFILE: "C:\\Users\\test",
          Path: "C:\\missing;C:\\shims",
        }),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) =>
              Effect.succeed(
                file === "C:\\shims\\adb.exe" || file === `${root}\\platform-tools\\adb.exe`,
              ),
            realPath: (file) =>
              Effect.sync(() => {
                resolved.push(file);
                return `${root}\\platform-tools\\adb.exe`;
              }),
          }),
        ),
        Effect.provide(NodePath.layerWin32),
      );
      expect(sdk).toMatchObject({ root, adb: true });
      expect(resolved).toEqual(["C:\\shims\\adb.exe"]);
    }),
  );

  it.effect("still requires SDK Platform-Tools on Windows when a standalone adb is on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(process.execPath);
      const root = "C:\\Android\\Sdk";
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          ANDROID_HOME: root,
          PATH: "C:\\tools",
        }),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) =>
              Effect.succeed(
                [
                  `${root}\\emulator\\emulator.exe`,
                  `${root}\\cmdline-tools\\latest\\bin\\avdmanager.bat`,
                  "C:\\tools\\adb.exe",
                ].includes(file),
              ),
            stat: () => Effect.succeed(info),
          }),
        ),
        Effect.provide(NodePath.layerWin32),
      );
      expect(sdk).toMatchObject({ root, adb: false, adbPath: null });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // regression: #12017 detect unsupported legacy Android command-line tools
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

  describe.runIf(HostProcess.Platform.defaultValue() !== "win32")("Unix system adb", () => {
    it.effect.each([
      { name: "ANDROID_HOME", variable: "ANDROID_HOME" },
      { name: "ANDROID_SDK_ROOT", variable: "ANDROID_SDK_ROOT" },
      { name: "the standard SDK location", variable: undefined },
    ])("accepts a system adb with $name", ({ variable }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-system-adb-" });
        const root = variable
          ? path.join(directory, "sdk")
          : path.join(directory, "Android", "Sdk");
        const bin = path.join(directory, "bin");
        const adbPath = path.join(bin, "adb");
        const emulator = path.join(root, "emulator", "emulator");
        for (const file of [
          adbPath,
          emulator,
          path.join(root, "cmdline-tools", "latest", "bin", "avdmanager"),
        ]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "#!/bin/sh\nexit 0\n");
          yield* fs.chmod(file, 0o755);
        }
        const environment = {
          HOME: directory,
          PATH: [path.join(directory, "missing"), bin].join(":"),
          ...(variable ? { [variable]: root } : {}),
        };
        const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
          Effect.provideService(HostProcess.Environment, environment),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect(sdk).toMatchObject({ root, adb: true, adbPath });
        expect(
          yield* LocalDeviceHost.__testing
            .platformReason("android")
            .pipe(
              Effect.provideService(HostProcess.Environment, environment),
              Effect.provideService(HostProcess.Platform, "linux"),
            ),
        ).toBeNull();
        yield* fs.remove(emulator);
        expect(
          yield* LocalDeviceHost.__testing.platformReason("android").pipe(
            Effect.provideService(HostProcess.Environment, {
              ...environment,
              ANDROID_HOME: root,
            }),
            Effect.provideService(HostProcess.Platform, "linux"),
          ),
        ).toContain("Android Emulator is missing");
        yield* fs.writeFileString(emulator, "emulator fixture");
        yield* fs.chmod(adbPath, 0o644);
        expect(
          yield* LocalDeviceHost.__testing.androidSdk.pipe(
            Effect.provideService(HostProcess.Environment, {
              ...environment,
              PATH: bin,
            }),
            Effect.provideService(HostProcess.Platform, "linux"),
          ),
        ).toMatchObject({ root, adb: false });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });

  it.effect("does not mistake a system adb for a complete SDK", () =>
    Effect.gen(function* () {
      expect(
        yield* diagnose(["/usr/bin/adb"], { HOME: "/test/home", PATH: "/usr/bin" }, "linux"),
      ).toContain("Android SDK was not found");
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
});

it.effect("never prepares a temporary SDK view on Windows", () =>
  Effect.gen(function* () {
    const environment = { ANDROID_HOME: "C:\\Android\\Sdk", PATH: "C:\\tools" };
    expect(
      yield* LocalDeviceHost.__testing.hubSdkEnvironment(
        environment,
        { root: environment.ANDROID_HOME, adbPath: "C:\\tools\\adb.exe" },
        "C:\\state",
      ),
    ).toBe(environment);
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        makeTempDirectoryScoped: () => Effect.die("Windows must not prepare an SDK view"),
      }),
    ),
    Effect.provide(NodePath.layerWin32),
  ),
);

it.effect.each(["NotFound", "BadResource", "PermissionDenied"] as const)(
  "does not prepare an SDK view when listing the root fails with %s",
  (reason) =>
    Effect.gen(function* () {
      const environment = { ANDROID_HOME: "/unavailable-sdk", PATH: "/usr/bin" };
      const result = yield* LocalDeviceHost.__testing.hubSdkEnvironment(
        environment,
        { root: environment.ANDROID_HOME, adbPath: "/usr/bin/adb" },
        "/must-not-be-used",
      );
      expect(result).toBe(environment);
    }).pipe(
      Effect.scoped,
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: reason,
                module: "FileSystem",
                method: "readDirectory",
              }),
            ),
          makeTempDirectoryScoped: () => Effect.die("An unavailable SDK must not allocate a view"),
        }),
      ),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provide(NodePath.layerPosix),
    ),
);

it.effect.runIf(HostProcess.Platform.defaultValue() !== "win32")(
  "makes a system adb available to SDK-only hub resolvers without changing the SDK",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hub-system-adb-" });
      const root = path.join(directory, "sdk");
      const bin = path.join(directory, "bin");
      yield* fs.makeDirectory(path.join(root, "platform-tools"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "emulator"));
      yield* fs.makeDirectory(path.join(root, "cmdline-tools", "latest", "bin"), {
        recursive: true,
      });
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(path.join(root, "emulator", "emulator"), "emulator fixture");
      yield* fs.writeFileString(
        path.join(root, "cmdline-tools", "latest", "bin", "avdmanager"),
        "tools fixture",
      );
      yield* fs.writeFileString(path.join(root, "source.properties"), "SDK fixture");
      const adbPath = path.join(bin, "adb");
      yield* fs.symlink(process.execPath, adbPath);
      const environment = { ANDROID_HOME: root, ANDROID_SDK_ROOT: root, PATH: bin };
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const env = yield* LocalDeviceHost.__testing
        .hubSdkEnvironment(environment, { root, adbPath }, directory)
        .pipe(Effect.provideService(Scope.Scope, scope));
      expect(env.ANDROID_HOME).not.toBe(root);
      expect(env.ANDROID_SDK_ROOT).toBe(env.ANDROID_HOME);
      expect(env.PATH).toBe(environment.PATH);
      expect(environment).toEqual({ ANDROID_HOME: root, ANDROID_SDK_ROOT: root, PATH: bin });
      const hubRoot = env.ANDROID_HOME!;
      expect(yield* fs.readFileString(path.join(hubRoot, "emulator", "emulator"))).toBe(
        "emulator fixture",
      );
      expect(
        yield* fs.readFileString(
          path.join(hubRoot, "cmdline-tools", "latest", "bin", "avdmanager"),
        ),
      ).toBe("tools fixture");
      expect(yield* fs.readFileString(path.join(hubRoot, "source.properties"))).toBe("SDK fixture");
      const result = yield* runner.run({
        command: path.join(hubRoot, "platform-tools", "adb"),
        args: ["-e", "process.stdout.write('system-adb')"],
        env,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("system-adb");
      yield* Scope.close(scope, Exit.void);
      expect(yield* fs.exists(hubRoot)).toBe(false);
      expect(yield* fs.readDirectory(path.join(root, "platform-tools"))).toEqual([]);
      expect(yield* fs.exists(adbPath)).toBe(true);
      expect(yield* fs.exists(path.join(root, "emulator", "emulator"))).toBe(true);
      expect(
        yield* LocalDeviceHost.__testing.hubSdkEnvironment(
          environment,
          { root, adbPath: path.join(root, "platform-tools", "adb") },
          "/must-not-be-used",
        ),
      ).toBe(environment);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer)),
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
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
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.UserId, uid),
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
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.UserId, 1000),
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        );
      expect(missing.XDG_RUNTIME_DIR).toBeUndefined();
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer)),
    ),
);

it.effect.each([
  {
    name: "old SDK",
    front: "emulated webcam<N> none",
    back: "emulated virtualscene none",
    code: 0,
    extra: undefined,
    expected: "-camera-front emulated -camera-back emulated",
  },
  {
    name: "imagefile-capable SDK",
    front: "emulated imagefile:<path> none",
    back: "emulated imagefile:<path> none",
    code: 0,
    extra: undefined,
    expected: undefined,
  },
  {
    name: "user overrides",
    front: "emulated none",
    back: "emulated none",
    code: 0,
    extra: "-memory 4096 -camera-front none",
    expected: "-camera-front emulated -camera-back emulated -memory 4096 -camera-front none",
  },
  {
    name: "different camera capabilities",
    front: "emulated none",
    back: "emulated imagefile:<path> none",
    code: 0,
    extra: undefined,
    expected: "-camera-front emulated",
  },
  {
    name: "failed help probe",
    front: "emulated none",
    back: "emulated none",
    code: 1,
    extra: undefined,
    expected: undefined,
  },
])("configures supported emulator cameras for $name", ({ front, back, code, extra, expected }) =>
  Effect.gen(function* () {
    const result = yield* LocalDeviceHost.__testing
      .hubEnvironment({ ANDROID_HOME: "/sdk", EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS: extra })
      .pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.UserId, 1000),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            expect(input.command).toBe("/sdk/emulator/emulator");
            expect(input.args[0]).toMatch(/^-help-camera-(front|back)$/);
            return Effect.succeed(
              processOutput(code, input.args[0] === "-help-camera-front" ? front : back),
            );
          },
        }),
        Effect.provide(NodeServices.layer),
      );
    expect(result.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS).toBe(expected);
  }),
);

it.effect("keeps local Android and iOS available without ffmpeg", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-ffmpeg-" });
    yield* fs.makeDirectory(`${baseDir}/bin`);
    yield* fs.writeFileString(`${baseDir}/bin/xcrun`, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(`${baseDir}/bin/xcrun`, 0o755);
    for (const [directory, tool] of [
      ["platform-tools", "adb"],
      ["emulator", "emulator"],
      ["cmdline-tools/latest/bin", "avdmanager"],
    ]) {
      yield* fs.makeDirectory(`${baseDir}/sdk/${directory}`, { recursive: true });
      yield* fs.writeFileString(`${baseDir}/sdk/${directory}/${tool}`, "");
    }
    const onTestHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: baseDir,
          PATH: `${baseDir}/bin`,
          ANDROID_HOME: `${baseDir}/sdk`,
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
    const host = yield* LocalDeviceHost.make().pipe(
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
      onTestHost,
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die(new Error("Readiness must not make network requests"))),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Platform availability must not probe emulator video"),
      }),
    );
    expect((yield* onTestHost(host.summary)).platforms).toEqual([
      { platform: "ios", available: true },
      { platform: "android", available: true },
    ]);
    expect(yield* onTestHost(host.platformAvailability("android"))).toEqual({
      platform: "android",
      available: true,
    });
    expect(yield* onTestHost(host.platformAvailability("ios"))).toEqual({
      platform: "ios",
      available: true,
    });
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
        Effect.provideService(HostProcess.Environment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(HostProcess.Platform, "linux"),
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
        .pipe(Effect.flip, Effect.provideService(HostProcess.IsExecutable, true));
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

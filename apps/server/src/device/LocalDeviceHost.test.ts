import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessIsExecutable,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient } from "effect/unstable/http";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const noRunner: ProcessRunner.ProcessRunner["Service"] = {
  run: () => Effect.die(new Error("Android diagnostics must not run commands")),
};

const diagnose = (
  files: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(ProcessRunner.ProcessRunner, noRunner),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
  );

const exited = (code: number, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** Runs the iOS check on macOS with a fake `xcrun simctl help` outcome. */
const diagnoseIos = (
  simctl: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  applications: ReadonlyArray<string> = ["Xcode.app"],
) =>
  LocalDeviceHost.__testing.platformReason("ios").pipe(
    Effect.provideService(HostProcessEnvironment, {}),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        expect([input.command, ...(input.args ?? [])]).toEqual(["xcrun", "simctl", "help"]);
        return simctl;
      },
    }),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ readDirectory: () => Effect.succeed([...applications]) }),
    ),
    Effect.provide(NodePath.layerPosix),
  );

describe("iOS Simulator availability", () => {
  it.effect("is available when xcrun can run simctl", () =>
    Effect.gen(function* () {
      expect(yield* diagnoseIos(Effect.succeed(exited(0)))).toBeNull();
    }),
  );

  it.effect("tells the user to point xcode-select at Xcode.app when simctl is missing", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.succeed(exited(72, 'xcrun: error: unable to find utility "simctl"')),
      );
      expect(reason).toContain("sudo xcode-select -s /Applications/Xcode.app/Contents/Developer");
    }),
  );

  it.effect("names the Xcode bundle it finds, such as a beta", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.succeed(exited(72, 'xcrun: error: unable to find utility "simctl"')),
        ["Safari.app", "Xcode-beta.app"],
      );
      expect(reason).toContain(
        "sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer",
      );
    }),
  );

  it.effect("quotes a bundle path with spaces", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.succeed(exited(72, 'xcrun: error: unable to find utility "simctl"')),
        ["Xcode 26.app"],
      );
      expect(reason).toContain(
        'sudo xcode-select -s "/Applications/Xcode 26.app/Contents/Developer"',
      );
    }),
  );

  it.effect("covers a missing Xcode and one outside /Applications when none is found", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.succeed(exited(72, 'xcrun: error: unable to find utility "simctl"')),
        ["Safari.app"],
      );
      expect(reason).toContain("Install Xcode");
      expect(reason).toContain("outside /Applications");
      expect(reason).not.toContain("/Applications/Xcode");
    }),
  );

  it.effect("passes through other simctl failures instead of blaming xcode-select", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.succeed(exited(69, "You have not agreed to the Xcode license agreements.")),
      );
      expect(reason).toBe(
        "xcrun simctl failed: You have not agreed to the Xcode license agreements.",
      );
    }),
  );

  it.effect("reports a hung probe instead of claiming tools are missing", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.fail(
          new ProcessRunner.ProcessTimeoutError({
            command: "xcrun",
            argumentCount: 2,
            timeoutMs: 15_000,
          }),
        ),
      );
      expect(reason).toMatch(/^Could not run xcrun simctl: .*timed out/);
    }),
  );

  const spawnFailure = (reason: "NotFound" | "PermissionDenied") =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: "xcrun",
        argumentCount: 2,
        cause: PlatformError.systemError({
          _tag: reason,
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: "xcrun",
        }),
      }),
    );

  it.effect("reports missing command line tools when xcrun does not exist", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(spawnFailure("NotFound"));
      expect(reason).toBe("Xcode command line tools were not found.");
    }),
  );

  it.effect("passes through other spawn failures instead of claiming tools are missing", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(spawnFailure("PermissionDenied"));
      expect(reason).toMatch(/^Could not run xcrun simctl: /);
    }),
  );
});

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

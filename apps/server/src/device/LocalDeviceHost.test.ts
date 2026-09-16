import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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

const diagnose = (files: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(ProcessRunner.ProcessRunner, noRunner),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(NodePath.layer),
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
      expect(reason).toContain("Command-line Tools (latest)");
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

const exited = (code: number, stderr = "", timedOut = false): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** Runs the iOS probe on macOS with a fake `xcrun simctl help` outcome. */
const diagnoseIos = (
  simctl: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
) =>
  LocalDeviceHost.__testing.platformReason("ios").pipe(
    Effect.provideService(HostProcessEnvironment, {}),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        expect(input.command).toBe("xcrun");
        expect(input.args).toEqual(["simctl", "help"]);
        return simctl;
      },
    }),
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
    Effect.provide(NodePath.layer),
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
      expect(reason).toContain("xcode-select -s /Applications/Xcode.app/Contents/Developer");
    }),
  );

  it.effect("passes through other simctl failures instead of blaming xcode-select", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.succeed(exited(69, "You have not agreed to the Xcode license agreements.")),
      );
      expect(reason).toContain("Xcode license");
      expect(reason).not.toContain("xcode-select");
    }),
  );

  it.effect("does not blame xcode-select when the probe times out", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(Effect.succeed(exited(0, "", true)));
      expect(reason).toContain("did not respond");
      expect(reason).not.toContain("xcode-select");
    }),
  );

  it.effect("surfaces other runner failures instead of claiming tools are missing", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.fail(
          new ProcessRunner.ProcessReadError({
            command: "xcrun",
            argumentCount: 2,
            stream: "stdout",
            cause: new Error("EIO"),
          }),
        ),
      );
      expect(reason).toContain("Could not run xcrun simctl");
    }),
  );

  it.effect("reports missing command line tools when xcrun cannot be spawned", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "xcrun",
            argumentCount: 2,
            cause: new Error("ENOENT"),
          }),
        ),
      );
      expect(reason).toBe("Xcode command line tools were not found.");
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
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

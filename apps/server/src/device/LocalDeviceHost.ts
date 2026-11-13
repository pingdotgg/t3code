import { pruneLocalDeviceTools } from "./deviceToolMaintenance.ts";
import { deviceToolInstallMessage } from "@t3tools/contracts";
// The hub runs at origin root; T3 strips its prefix and the Device panel derives stream URLs from it.
import {
  type DeviceHostSummary,
  type DevicePlatform,
  type DevicePlatformAvailability,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
} from "@t3tools/contracts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveNodeExecutable,
  type NodeRuntimeUnavailableError,
} from "@t3tools/shared/nodeRuntime";
import * as NetService from "@t3tools/shared/Net";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { releaseAgentDeviceSession } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import {
  agentDeviceStateDir,
  type DeviceToolPaths,
  ensureAgentDevice,
  ensureDeviceHub,
  isAgentDeviceInstalled,
  isDeviceHubInstalled,
  deviceToolVersions,
  DEVICE_HUB_VERSION,
} from "./DeviceToolchain.ts";

export const HUB_READY_TIMEOUT_MS = 30_000;
export const DAEMON_READY_TIMEOUT_MS = 30_000;
export const DAEMON_POLL_MS = 100;
export const HUB_RESTART_STABLE_UPTIME_MS = 60_000;
export const HUB_RESTART_MAX_DELAY_MS = 30_000;

// Persist hub state so restarts without finalizers can clean up orphaned loopback listeners.
const HubStateFile = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  entryPath: Schema.String,
});
export const decodeHubStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(HubStateFile));
export const encodeHubStateFile = Schema.encodeUnknownEffect(Schema.fromJsonString(HubStateFile));

export const AgentDeviceDaemonFile = Schema.Struct({
  httpPort: Schema.Int,
  token: Schema.String,
  pid: Schema.optional(Schema.Int),
  version: Schema.optional(Schema.String),
});
export const decodeDaemonFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDeviceDaemonFile));

export const decodeAgentDeviceFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        details: Schema.Struct({
          reason: Schema.String,
          inspection: Schema.optional(Schema.Struct({ reason: Schema.String })),
        }),
      }),
    }),
  ),
);

export interface HubProcess {
  readonly nodePath: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly origin: string;
  readonly startedAtMillis: number;
}

export interface RunningHost {
  readonly hub: HubProcess;
  readonly agentDevice: DeviceHost.AgentDeviceEndpoint | null;
  readonly helpers: DeviceHost.DeviceHostReady["helpers"];
}

export const platformReason = Effect.fn("LocalDeviceHost.platformReason")(function* (
  platform: DevicePlatform,
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const hostPlatform = yield* HostProcess.Platform;
  if (platform === "ios") {
    if (hostPlatform !== "darwin") return "iOS Simulators need macOS with Xcode.";
    if (!(yield* isCommandAvailable("xcrun"))) return "Xcode command line tools were not found.";
    return null;
  }
  const sdk = yield* androidSdk;
  if (!sdk.root)
    return "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.";
  if (!sdk.adb)
    return `Android SDK Platform-Tools are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
  if (!sdk.emulator)
    return `Android Emulator is missing from ${sdk.root}. Install it in Android Studio's SDK Manager.`;
  if (!sdk.avdmanager) {
    if (sdk.legacyAvdmanager)
      return `The Android SDK command-line tools in ${sdk.root} appear to be an older, unsupported version. Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.`;
    return `Android SDK Command-line Tools (latest) are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
  }
  return null;
});

export const androidSdk = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const windows = platform === "win32";
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const explicit = environment.ANDROID_HOME?.trim() || environment.ANDROID_SDK_ROOT?.trim();
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const adbBinary = windows ? "adb.exe" : "adb";
  const avdmanagerBinary = windows ? "avdmanager.bat" : "avdmanager";
  const inspect = Effect.fnUntraced(function* (root: string) {
    const adb = yield* exists(path.join(root, "platform-tools", adbBinary));
    const emulator = yield* exists(
      path.join(root, "emulator", windows ? "emulator.exe" : "emulator"),
    );
    if (!explicit && !adb && !emulator) return null;
    const avdmanager = yield* exists(
      path.join(root, "cmdline-tools", "latest", "bin", avdmanagerBinary),
    );
    const legacyAvdmanager =
      !avdmanager && (yield* exists(path.join(root, "tools", "bin", avdmanagerBinary)));
    return { root, adb, emulator, avdmanager, legacyAvdmanager };
  });
  const candidates = explicit
    ? [explicit]
    : [
        path.join(home, "Library", "Android", "sdk"),
        path.join(home, "Android", "Sdk"),
        path.join(
          environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
          "Android",
          "Sdk",
        ),
      ];
  for (const root of candidates) {
    const sdk = yield* inspect(root);
    if (sdk) return sdk;
  }
  // PATH entries can be slow to stat (network shares), so only consult them after the standard locations miss.
  if (!explicit) {
    const searchPath = environment.PATH ?? environment.Path ?? "";
    for (const directory of searchPath.split(windows ? ";" : ":")) {
      if (!directory) continue;
      const adb = path.join(directory, adbBinary);
      if (!(yield* exists(adb))) continue;
      const resolved = yield* fs.realPath(adb).pipe(Effect.orElseSucceed(() => adb));
      const sdk = yield* inspect(path.dirname(path.dirname(resolved)));
      if (sdk) return sdk;
    }
  }
  return { root: null, adb: false, emulator: false, avdmanager: false, legacyAvdmanager: false };
});

export const deviceHostEnvironment = (
  environment: NodeJS.ProcessEnv,
  sdkRoot: string | null,
  hostPlatform: NodeJS.Platform,
  path: Path.Path,
): NodeJS.ProcessEnv => {
  return sdkRoot
    ? {
        ...environment,
        ANDROID_HOME: sdkRoot,
        PATH: [
          path.join(sdkRoot, "platform-tools"),
          path.join(sdkRoot, "emulator"),
          environment.PATH ?? environment.Path ?? "",
        ].join(hostPlatform === "win32" ? ";" : ":"),
      }
    : environment;
};

export const hubEnvironment = Effect.fn("LocalDeviceHost.hubEnvironment")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const env: NodeJS.ProcessEnv = { ...environment, FORCE_COLOR: "0", NO_COLOR: "1" };
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  if (env.ANDROID_HOME) {
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const emulator = path.join(
      env.ANDROID_HOME,
      "emulator",
      platform === "win32" ? "emulator.exe" : "emulator",
    );
    const cameraArgs = yield* Effect.forEach(["front", "back"], (facing) =>
      runner
        .run({
          command: emulator,
          args: [`-help-camera-${facing}`],
          env,
          timeout: Duration.seconds(5),
        })
        .pipe(
          Effect.map((result) => {
            const help = `${result.stdout}\n${result.stderr}`;
            // The hub wires imagefile cameras unconditionally; older SDK emulators reject that mode.
            return result.code === 0 && /\bemulated\b/.test(help) && !/\bimagefile\b/.test(help)
              ? `-camera-${facing} emulated`
              : "";
          }),
          Effect.orElseSucceed(() => ""),
        ),
    );
    const overrides = cameraArgs.filter(Boolean).join(" ");
    if (overrides) {
      env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS = [overrides, env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS]
        .filter(Boolean)
        .join(" ");
    }
  }
  if (platform === "linux" && env.XDG_RUNTIME_DIR === undefined && uid !== undefined) {
    // SSH sessions may omit the directory where the emulator publishes its gRPC token.
    const runtimeDir = `/run/user/${uid}`;
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(runtimeDir).pipe(Effect.option);
    if (
      stat._tag === "Some" &&
      stat.value.type === "Directory" &&
      Option.contains(stat.value.uid, uid)
    ) {
      env.XDG_RUNTIME_DIR = runtimeDir;
    }
  }
  return env;
});

/** Only a Mac can list Apple simulators; elsewhere the hub's attempt surfaces as an error. */
export const hubPlatformArguments = (hostPlatform: NodeJS.Platform) =>
  hostPlatform === "darwin" ? [] : ["--platform", "android"];

import { makeLocalDeviceHost as make } from "./LocalDeviceHostMake.ts";
export { makeLocalDeviceHost, makeLocalDeviceHost as make } from "./LocalDeviceHostMake.ts";
export const layer = Layer.effect(DeviceHost.DeviceHost, make());

export const __testing = {
  AgentDeviceDaemonFile,
  androidSdk,
  platformReason,
  deviceHostEnvironment,
  hubEnvironment,
};

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
import * as Deferred from "effect/Deferred";
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
import { deviceHubNodeArgs } from "./deviceHubNodeArgs.ts";
import {
  agentDeviceStateDir,
  type DeviceToolPaths,
  ensureAgentDevice,
  ensureDeviceHub,
  isAgentDeviceInstalled,
  isDeviceHubInstalled,
  deviceToolVersions,
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  installedAgentDeviceEntry,
} from "./DeviceToolchain.ts";

const HUB_READY_TIMEOUT_MS = 30_000;
const HUB_TOKEN_PATTERN = /\btoken=([\w.~-]+)/;
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MS = 100;
const HUB_RESTART_STABLE_UPTIME_MS = 60_000;
const HUB_RESTART_MAX_DELAY_MS = 30_000;

// Persist hub state so restarts without finalizers can clean up orphaned loopback listeners.
const HubStateFile = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  entryPath: Schema.String,
});
const decodeHubStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(HubStateFile));
const encodeHubStateFile = Schema.encodeUnknownEffect(Schema.fromJsonString(HubStateFile));

const AgentDeviceDaemonFile = Schema.Struct({
  httpPort: Schema.Int,
  token: Schema.String,
  pid: Schema.optional(Schema.Int),
  version: Schema.optional(Schema.String),
});
const decodeDaemonFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDeviceDaemonFile));

const decodeAgentDeviceFailure = Schema.decodeUnknownOption(
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

interface HubProcess {
  readonly nodePath: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly origin: string;
  readonly token: string;
  readonly startedAtMillis: number;
  readonly emulatorExtraArgs: string | undefined;
  readonly emulatorStamp: string | undefined;
}

interface RunningHost {
  readonly hub: HubProcess;
  readonly agentDevice: DeviceHost.AgentDeviceEndpoint | null;
  readonly helpers: DeviceHost.DeviceHostReady["helpers"];
}

const platformReason = Effect.fn("LocalDeviceHost.platformReason")(function* (
  platform: DevicePlatform,
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const hostPlatform = yield* HostProcess.Platform;
  if (platform === "ios") {
    if (hostPlatform !== "darwin") return "iOS Simulators need macOS with Xcode.";
    if (!(yield* isCommandAvailable("xcrun"))) return "Xcode command line tools were not found.";
    return null;
  }
  const sdk = yield* androidSdk;
  // Connected phones need only adb; emulator tooling gates AVD listing alone.
  if (sdk.adb) return null;
  if (!sdk.root)
    return "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.";
  return `Android SDK Platform-Tools are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
});

interface AndroidSdk {
  readonly root: string | null;
  readonly adb: boolean;
  readonly emulator: boolean;
  readonly standaloneAdb: string | null;
}

const androidSdk = Effect.gen(function* (): Effect.fn.Return<
  AndroidSdk,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const windows = platform === "win32";
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const explicit = [environment.ANDROID_HOME?.trim(), environment.ANDROID_SDK_ROOT?.trim()].filter(
    (root): root is string => !!root,
  );
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const adbBinary = windows ? "adb.exe" : "adb";
  const inspect = Effect.fnUntraced(function* (root: string) {
    const adb = yield* exists(path.join(root, "platform-tools", adbBinary));
    const emulator = yield* exists(
      path.join(root, "emulator", windows ? "emulator.exe" : "emulator"),
    );
    return { root, adb, emulator, standaloneAdb: null };
  });
  const candidates = [
    ...explicit,
    path.join(home, "Library", "Android", "sdk"),
    path.join(home, "Android", "Sdk"),
    path.join(environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Android", "Sdk"),
  ];
  for (const root of candidates) {
    const sdk = yield* inspect(root);
    if (sdk.adb || sdk.emulator) return sdk;
  }
  // PATH entries can be slow to stat (network shares), so only consult them after the standard locations miss.
  const searchPath = environment.PATH ?? environment.Path ?? "";
  let standaloneAdb: string | null = null;
  for (const directory of searchPath.split(windows ? ";" : ":")) {
    if (!directory) continue;
    const adb = path.join(directory, adbBinary);
    if (!(yield* exists(adb))) continue;
    const resolved = yield* fs.realPath(adb).pipe(Effect.orElseSucceed(() => adb));
    const sdk = yield* inspect(path.dirname(path.dirname(resolved)));
    if (sdk.adb || sdk.emulator) return sdk;
    // Distro and Homebrew adb packages install adb outside any SDK.
    standaloneAdb ??= resolved;
  }
  if (standaloneAdb) return { root: null, adb: true, emulator: false, standaloneAdb };
  // No real SDK anywhere: report what the configured root is missing.
  if (explicit[0]) return yield* inspect(explicit[0]);
  return { root: null, adb: false, emulator: false, standaloneAdb: null };
});

const deviceHostEnvironment = (
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

const hubEnvironment = Effect.fn("LocalDeviceHost.hubEnvironment")(function* (
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
const hubPlatformArguments = (hostPlatform: NodeJS.Platform) =>
  hostPlatform === "darwin" ? [] : ["--platform", "android"];

export const make = Effect.fn("LocalDeviceHost.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const net = yield* NetService.NetService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const workingDirectory = yield* HostProcess.WorkingDirectory;
  const hostPlatform = yield* HostProcess.Platform;
  // The hub and agent-device only run <ANDROID_HOME>/platform-tools/adb, so a standalone adb gets that layout.
  const standaloneSdkRoot = path.join(config.stateDir, "device", "android-sdk");
  const linkStandaloneAdb = (adb: string) => {
    const link = path.join(standaloneSdkRoot, "platform-tools", path.basename(adb));
    const linked = fs.readLink(link).pipe(
      Effect.map((target) => target === adb),
      Effect.orElseSucceed(() => false),
    );
    return Effect.gen(function* () {
      if (yield* linked) return true;
      yield* fs.makeDirectory(path.dirname(link), { recursive: true }).pipe(Effect.ignore);
      yield* fs.remove(link).pipe(Effect.ignore);
      yield* fs.symlink(adb, link).pipe(Effect.ignore);
      // A concurrent caller may have made the same link first.
      return yield* linked;
    });
  };
  // Resolved per use: the desktop shell snapshot can select another SDK after the host exists.
  const currentSdk = Effect.gen(function* () {
    const sdk = yield* androidSdk.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(HostProcess.Platform, hostPlatform),
    );
    if (sdk.standaloneAdb === null || !(yield* linkStandaloneAdb(sdk.standaloneAdb))) return sdk;
    return { ...sdk, root: standaloneSdkRoot };
  });
  const currentHostEnvironment = currentSdk.pipe(
    Effect.map((sdk) => deviceHostEnvironment(environment, sdk.root, hostPlatform, path)),
  );
  const startLock = yield* Semaphore.make(1);
  const runningRef = yield* Ref.make<RunningHost | null>(null);
  const restartDelayRef = yield* Ref.make(0);
  const hostId = LOCAL_DEVICE_HOST_ID;

  const platformAvailability = Effect.fn("LocalDeviceHost.platformAvailability")(function* (
    platform: DevicePlatform,
  ): Effect.fn.Return<DevicePlatformAvailability> {
    const reason = yield* platformReason(platform).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return reason === null ? { platform, available: true } : { platform, available: false, reason };
  });

  const summary: Effect.Effect<DeviceHostSummary> = Effect.gen(function* () {
    const [platforms, hubInstalled, agentDeviceInstalled] = yield* Effect.all([
      Effect.all([platformAvailability("ios"), platformAvailability("android")]),
      isDeviceHubInstalled(config.baseDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
      isAgentDeviceInstalled(config.baseDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    ]);
    const running = yield* Ref.get(runningRef);
    const daemon = running?.agentDevice
      ? yield* readDaemonFile().pipe(Effect.option)
      : Option.none();
    const hubAlive = running
      ? yield* running.hub.child.isRunning.pipe(Effect.orElseSucceed(() => false))
      : false;
    const agentAlive =
      Option.isSome(daemon) && daemon.value.pid ? yield* isProcessAlive(daemon.value.pid) : false;
    const tools = yield* deviceToolVersions(config.baseDir, {
      ...(hubAlive ? { hub: DEVICE_HUB_VERSION } : {}),
      ...(agentAlive && Option.isSome(daemon) && daemon.value.version
        ? { agent: daemon.value.version }
        : {}),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return {
      tools,
      id: hostId,
      kind: "local",
      label: LOCAL_DEVICE_HOST_LABEL,
      platforms,
      hubInstalled,
      agentDeviceInstalled,
    };
  });

  const stopHub = (hub: HubProcess | undefined) =>
    hub ? Scope.close(hub.scope, Exit.void).pipe(Effect.ignore) : Effect.void;

  const hubStatePath = () => path.join(agentDeviceStateDir(path, config.stateDir), "hub.json");

  const isProcessAlive = (pid: number) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  // Check PID and entry path before reaping; the PID may have been recycled.
  const reapStaleHub = Effect.gen(function* () {
    const previous = yield* fs
      .readFileString(hubStatePath())
      .pipe(Effect.flatMap(decodeHubStateFile), Effect.option);
    if (previous._tag === "None") return;
    const alive = yield* isProcessAlive(previous.value.pid);
    if (alive) {
      const commandLine = yield* runner
        .run({
          command: "ps",
          args: ["-o", "command=", "-p", String(previous.value.pid)],
          timeout: Duration.seconds(5),
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((result) => result.stdout),
          Effect.orElseSucceed(() => ""),
        );
      if (commandLine.includes(previous.value.entryPath)) {
        yield* Effect.logWarning("Stopping a device hub left behind by a previous server", {
          pid: previous.value.pid,
          port: previous.value.port,
        });
        yield* Effect.sync(() => {
          try {
            process.kill(previous.value.pid, "SIGTERM");
          } catch {}
        });
      }
    }
    yield* fs.remove(hubStatePath(), { force: true }).pipe(Effect.ignore);
  }).pipe(Effect.ignoreCause);

  const recordHub = (hub: HubProcess, hubTool: DeviceToolPaths) =>
    encodeHubStateFile({
      pid: Number(hub.child.pid),
      port: Number(new URL(hub.origin).port),
      entryPath: hubTool.entryPath,
    }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: hubStatePath(), contents }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.ignore,
    );

  const currentHubEnvironment = Effect.gen(function* () {
    return yield* hubEnvironment(yield* currentHostEnvironment).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, hostPlatform),
    );
  });

  // The camera probe spawns the emulator; re-run it for a live hub only after the binary changes.
  const emulatorStamp = Effect.gen(function* () {
    const sdk = yield* currentSdk;
    if (!sdk.root) return undefined;
    const binary = path.join(
      sdk.root,
      "emulator",
      hostPlatform === "win32" ? "emulator.exe" : "emulator",
    );
    const info = yield* fs.stat(binary).pipe(Effect.option);
    if (Option.isNone(info)) return undefined;
    return `${Option.getOrUndefined(info.value.mtime)?.getTime()}:${info.value.size}`;
  });

  const spawnHub = Effect.fn("LocalDeviceHost.spawnHub")(function* (
    hubTool: DeviceToolPaths,
    nodePath: string,
    env: NodeJS.ProcessEnv,
  ): Effect.fn.Return<HubProcess, DeviceHost.DeviceHostError> {
    yield* reapStaleHub;
    const stamp = yield* emulatorStamp;
    yield* fs
      .makeDirectory(agentDeviceStateDir(path, config.stateDir), { recursive: true })
      .pipe(Effect.ignore);
    // The hub records its token in this folder, kept with the rest of the server's state.
    const hubStateDir = path.join(config.stateDir, "device", "hub");
    yield* fs.makeDirectory(hubStateDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
    const port = yield* net.reserveLoopbackPort("127.0.0.1").pipe(
      Effect.mapError(
        (cause) =>
          new DeviceHost.DeviceHostError({
            hostId,
            step: "reserving a port for the device hub",
            cause,
          }),
      ),
    );
    const origin = `http://127.0.0.1:${port}`;
    const scope = yield* Scope.make("sequential");
    // The hub is not recorded yet; stop it on failure or interruption from spawn onward.
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            nodePath,
            [
              ...deviceHubNodeArgs(hubTool.entryPath, hostPlatform),
              "--port",
              String(port),
              "--host",
              "127.0.0.1",
              // Only the server, which reads the token the hub prints, talks to the hub.
              "--require-token",
              "--hide-sidebar",
              "--hide-boot-device",
              ...hubPlatformArguments(hostPlatform),
            ],
            {
              cwd: workingDirectory,
              detached: false,
              shell: false,
              stdout: "pipe",
              stderr: "pipe",
              env: { ...env, EXPO_DEVICE_HUB_STATE_DIR: hubStateDir },
            },
          ),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new DeviceHost.DeviceHostError({
                hostId,
                step: "starting the device hub",
                cause,
              }),
          ),
        );
      const startedAtMillis = yield* Clock.currentTimeMillis;
      const announcedToken = yield* Deferred.make<string>();
      yield* Effect.forkIn(observeHubOutput(child, announcedToken), scope);
      yield* waitForHttpReady({
        baseUrl: origin,
        path: "/readyz",
        timeoutMs: HUB_READY_TIMEOUT_MS,
        makeError: (info) =>
          new DeviceHost.DeviceHostError({
            hostId,
            step: "waiting for the device hub to answer",
            cause: info.cause,
          }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      const token = yield* Deferred.await(announcedToken).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(HUB_READY_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(
              new DeviceHost.DeviceHostError({
                hostId,
                step: "reading the device hub's session token",
                cause: new Error("The device hub did not print a session token."),
              }),
            ),
        }),
      );
      const hub: HubProcess = {
        child,
        scope,
        origin,
        token,
        startedAtMillis,
        nodePath,
        emulatorExtraArgs: env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS,
        emulatorStamp: stamp,
      };
      yield* recordHub(hub, hubTool);
      yield* Effect.logInfo("Device hub started", { pid: Number(child.pid), port });
      return hub;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  // The hub generates its session token and prints it in its startup link; keep it out of logs.
  const observeHubOutput = (
    child: ChildProcessSpawner.ChildProcessHandle,
    announcedToken: Deferred.Deferred<string>,
  ) =>
    child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) => {
        const token = HUB_TOKEN_PATTERN.exec(line)?.[1];
        return (token === undefined ? Effect.void : Deferred.succeed(announcedToken, token)).pipe(
          Effect.andThen(
            Effect.logDebug("Device hub output", {
              pid: Number(child.pid),
              output: line.replace(HUB_TOKEN_PATTERN, "token=<redacted>"),
            }),
          ),
        );
      }),
      Effect.ignoreCause,
    );

  // Waits for the hub's lifetime and re-forks on restart; a span would nest across restarts.
  const superviseHub: (hub: HubProcess, hubTool: DeviceToolPaths) => Effect.Effect<void> =
    Effect.fnUntraced(
      function* (hub: HubProcess, hubTool: DeviceToolPaths) {
        yield* Effect.result(hub.child.exitCode);
        const running = yield* Ref.get(runningRef);
        if (running?.hub.child.pid !== hub.child.pid) return;
        const uptime = (yield* Clock.currentTimeMillis) - hub.startedAtMillis;
        const delay = yield* Ref.modify(restartDelayRef, (current) => {
          if (uptime >= HUB_RESTART_STABLE_UPTIME_MS) return [0, 0];
          const next = current === 0 ? 1_000 : Math.min(current * 2, HUB_RESTART_MAX_DELAY_MS);
          return [current, next];
        });
        yield* Effect.logWarning("Device hub exited; restarting", {
          pid: Number(hub.child.pid),
          delayMs: delay,
        });
        yield* Effect.sleep(Duration.millis(delay));
        yield* startLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(runningRef);
            if (current?.hub.child.pid !== hub.child.pid) return;
            const replacement = yield* spawnHub(
              hubTool,
              hub.nodePath,
              yield* currentHubEnvironment,
            );
            yield* Ref.set(runningRef, { ...current, hub: replacement });
            yield* Effect.forkDetach(superviseHub(replacement, hubTool));
          }),
        );
      },
      Effect.catchCause((cause) => Effect.logWarning("Device hub supervisor failed", { cause })),
    );

  const daemonFilePath = () => path.join(agentDeviceStateDir(path, config.stateDir), "daemon.json");

  const readDaemonFile = Effect.fn("LocalDeviceHost.readDaemonFile")(function* () {
    const raw = yield* fs.readFileString(daemonFilePath());
    return yield* decodeDaemonFile(raw);
  });

  const startAgentDeviceDaemon = Effect.fn("LocalDeviceHost.startAgentDeviceDaemon")(function* (
    agentTool: Pick<DeviceToolPaths, "entryPath">,
    nodePath: string,
  ): Effect.fn.Return<
    DeviceHost.AgentDeviceEndpoint,
    | DeviceHost.DeviceHostError
    | DeviceHost.DeviceHostTimeoutError
    | DeviceHost.AgentDeviceStartError
  > {
    const stateDir = agentDeviceStateDir(path, config.stateDir);
    yield* fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.ignore);
    const existing = yield* readDaemonFile().pipe(Effect.option);
    const daemonEnvironment: NodeJS.ProcessEnv = {
      ...(yield* currentHostEnvironment),
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      // Disable the five-minute idle timeout; the server owns shutdown.
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    const toEndpoint = (
      file: typeof AgentDeviceDaemonFile.Type,
    ): DeviceHost.AgentDeviceEndpoint => ({
      baseUrl: `http://127.0.0.1:${file.httpPort}`,
      token: file.token,
      entryPath: agentTool.entryPath,
    });
    const daemonAnswersHealth = (httpPort: number) =>
      HttpClient.withScope(httpClient)
        .get(`http://127.0.0.1:${httpPort}/health`)
        .pipe(
          Effect.flatMap((response) =>
            response.arrayBuffer.pipe(Effect.as(response.status === 200)),
          ),
          Effect.timeout(Duration.seconds(2)),
          Effect.scoped,
          Effect.orElseSucceed(() => false),
        );
    if (existing._tag === "Some") {
      const alive = yield* daemonAnswersHealth(existing.value.httpPort);
      const samePin =
        existing.value.version === undefined || existing.value.version === AGENT_DEVICE_VERSION;
      if (alive && samePin) return toEndpoint(existing.value);
      // A live daemon from another pin may speak another RPC protocol. Keep its registration so
      // the pinned CLI retires it, which that CLI does only while the daemon holds no work.
      if (!alive) yield* fs.remove(daemonFilePath(), { force: true }).pipe(Effect.ignore);
    }
    // No `daemon start` exists; `devices` is the cheapest command that starts and awaits it.
    const runResult = yield* runner
      .run({
        command: nodePath,
        args: [agentTool.entryPath, "devices", "--json"],
        env: daemonEnvironment,
        timeout: Duration.millis(DAEMON_READY_TIMEOUT_MS),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.result);
    // A failed run can stop the previous daemon and leave its file. Keep that registration
    // only while it still answers; a successful run has published the endpoint it reached.
    const started = yield* readDaemonFile().pipe(Effect.option);
    if (started._tag === "Some") {
      const runSucceeded =
        runResult._tag === "Success" && !runResult.success.timedOut && runResult.success.code === 0;
      if (runSucceeded || (yield* daemonAnswersHealth(started.value.httpPort))) {
        return toEndpoint(started.value);
      }
    }
    if (runResult._tag === "Failure") {
      return yield* new DeviceHost.DeviceHostError({
        hostId,
        step: "starting agent tools",
        cause: runResult.failure,
      });
    }
    const result = runResult.success;
    if (result.timedOut) {
      return yield* new DeviceHost.DeviceHostTimeoutError({
        hostId,
        timeoutMs: DAEMON_READY_TIMEOUT_MS,
      });
    }
    if (result.code !== 0) {
      const failure = decodeAgentDeviceFailure(result.stdout);
      const details = Option.isSome(failure) ? failure.value.error.details : undefined;
      const reason =
        details?.reason === "daemon_registration_unproven"
          ? details.inspection?.reason === "non-directory"
            ? "daemon_lock_not_directory"
            : "daemon_registration_unproven"
          : details?.reason === "daemon_retirement_unconfirmed"
            ? "daemon_retirement_unconfirmed"
            : "command_failed";
      return yield* new DeviceHost.AgentDeviceStartError({
        hostId,
        stateDir,
        exitCode: result.code === null ? null : Number(result.code),
        reason,
        cause: result,
      });
    }
    const deadline = (yield* Clock.currentTimeMillis) + DAEMON_READY_TIMEOUT_MS;
    while (true) {
      const file = yield* readDaemonFile().pipe(Effect.option);
      if (file._tag === "Some") return toEndpoint(file.value);
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new DeviceHost.DeviceHostTimeoutError({
          hostId,
          timeoutMs: DAEMON_READY_TIMEOUT_MS,
        });
      }
      yield* Effect.sleep(Duration.millis(DAEMON_POLL_MS));
    }
  });

  // The daemon may predate this process (an earlier server was killed, possibly on an
  // older pin), so stop it with the CLI of its recorded version when that is installed.
  const stopAgentDeviceDaemon = Effect.gen(function* () {
    if (!(yield* fs.exists(daemonFilePath()))) return;
    const recorded = yield* readDaemonFile().pipe(Effect.option);
    if (
      Option.isSome(recorded) &&
      recorded.value.pid &&
      !(yield* isProcessAlive(recorded.value.pid))
    ) {
      return yield* fs.remove(daemonFilePath(), { force: true });
    }
    const entryPath = yield* installedAgentDeviceEntry(config.baseDir, [
      ...(Option.isSome(recorded) && recorded.value.version ? [recorded.value.version] : []),
      AGENT_DEVICE_VERSION,
    ]);
    if (!entryPath) return;
    const hostEnvironment = yield* currentHostEnvironment;
    const nodePath = yield* resolveNodeExecutable("Local device support", hostEnvironment).pipe(
      Effect.provideService(HostProcess.Platform, hostPlatform),
    );
    yield* runner.run({
      command: nodePath,
      args: [
        entryPath,
        "daemon",
        "stop",
        "--state-dir",
        agentDeviceStateDir(path, config.stateDir),
      ],
      env: { ...hostEnvironment, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" },
      timeout: Duration.seconds(10),
      timeoutBehavior: "timedOutResult",
    });
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.ignore,
  );

  const ensureHubReady = Effect.fn("LocalDeviceHost.ensureHubReady")(function* (
    onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
  ): Effect.fn.Return<RunningHost, DeviceHost.DeviceHostError | NodeRuntimeUnavailableError> {
    const running = yield* Ref.get(runningRef);
    let env: NodeJS.ProcessEnv | undefined;
    // A dead hub's record stays until a replacement is published: the agent
    // daemon outlives the hub, and close needs its endpoint if the restart fails.
    if (running) {
      const alive = yield* running.hub.child.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (alive) {
        const stamp = yield* emulatorStamp;
        if (stamp === running.hub.emulatorStamp) return running;
        // An updated emulator can change the camera overrides; replace the hub only if they did.
        env = yield* currentHubEnvironment;
        if (env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS === running.hub.emulatorExtraArgs) {
          const next = { ...running, hub: { ...running.hub, emulatorStamp: stamp } };
          yield* Ref.set(runningRef, next);
          return next;
        }
        yield* stopHub(running.hub);
      }
    }
    const nodePath = yield* resolveNodeExecutable(
      "Local device support",
      yield* currentHostEnvironment,
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, hostPlatform),
    );
    const installed = yield* isDeviceHubInstalled(config.baseDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (!installed) {
      const inventory = yield* summary;
      yield* onPhase("installing", deviceToolInstallMessage("device hub", inventory.tools?.hub));
    }
    const hubTool = yield* ensureDeviceHub(config.baseDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.mapError(
        (cause) =>
          new DeviceHost.DeviceHostError({
            hostId,
            step: "installing device support",
            cause,
          }),
      ),
    );
    yield* onPhase("starting");
    const hub = yield* spawnHub(hubTool, nodePath, env ?? (yield* currentHubEnvironment));
    const next = yield* Effect.gen(function* () {
      yield* pruneLocalDeviceTools(config.baseDir, nodePath, "hub").pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.ignore,
      );
      const candidate = helperPaths(hubTool);
      const [axExists, cliExists] = yield* Effect.all([
        fs.exists(candidate.serveSimAxSettings).pipe(Effect.orElseSucceed(() => false)),
        fs.exists(candidate.serveSimCli).pipe(Effect.orElseSucceed(() => false)),
      ]);
      const next: RunningHost = {
        hub,
        agentDevice: running?.agentDevice ?? null,
        helpers: {
          serveSimAxSettings: axExists ? candidate.serveSimAxSettings : null,
          serveSimCli: cliExists ? candidate.serveSimCli : null,
        },
      };
      yield* Ref.set(runningRef, next);
      return next;
    }).pipe(Effect.onError(() => stopHub(hub)));
    yield* Ref.set(restartDelayRef, 0);
    yield* Effect.forkDetach(superviseHub(hub, hubTool));
    return next;
  });

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    startLock.withPermits(1)(ensureHubReady(onPhase).pipe(Effect.map(toReady)));

  const ensureAgentReady: DeviceHost.DeviceHost["Service"]["ensureAgentReady"] = (onPhase) =>
    startLock.withPermits(1)(
      Effect.gen(function* (): Generator<
        Effect.Effect<
          unknown,
          | DeviceHost.DeviceHostError
          | DeviceHost.DeviceHostTimeoutError
          | DeviceHost.AgentDeviceStartError
          | NodeRuntimeUnavailableError
        >,
        DeviceHost.DeviceHostAgentReady
      > {
        const running = yield* ensureHubReady(onPhase);
        if (running.agentDevice) {
          const agentDevice = yield* startAgentDeviceDaemon(
            running.agentDevice,
            running.hub.nodePath,
          );
          yield* Ref.set(runningRef, { ...running, agentDevice });
          return { ...toReady(running), agentDevice };
        }
        const installed = yield* isAgentDeviceInstalled(config.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (!installed) {
          const inventory = yield* summary;
          yield* onPhase(
            "installing",
            deviceToolInstallMessage("agent tools", inventory.tools?.agent),
          );
        }
        const agentTool = yield* ensureAgentDevice(config.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.mapError(
            (cause) =>
              new DeviceHost.DeviceHostError({
                hostId,
                step: "installing agent tools",
                cause,
              }),
          ),
        );
        yield* onPhase("starting");
        const agentDevice = yield* startAgentDeviceDaemon(agentTool, running.hub.nodePath);
        yield* pruneLocalDeviceTools(config.baseDir, running.hub.nodePath, "agent").pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.ignore,
        );
        const next = { ...running, agentDevice };
        yield* Ref.set(runningRef, next);
        return { ...toReady(next), agentDevice };
      }),
    );

  const helperPaths = (hubTool: DeviceToolPaths) => {
    const serveSimDist = path.join(
      hubTool.installDir,
      "node_modules",
      "expo-device-hub",
      "vendor",
      "serve-sim",
      "dist",
    );
    return {
      serveSimAxSettings: path.join(serveSimDist, "simax", "serve-sim-ax-settings"),
      serveSimCli: path.join(serveSimDist, "serve-sim.js"),
    };
  };

  const run: DeviceHost.DeviceHostReady["run"] = (command, args, options) =>
    currentSdk.pipe(
      Effect.flatMap((sdk) =>
        runner.run({
          command:
            command === "emulator" && sdk.root
              ? path.join(
                  sdk.root,
                  "emulator",
                  hostPlatform === "win32" ? "emulator.exe" : "emulator",
                )
              : command,
          args,
          cwd: workingDirectory,
          env: deviceHostEnvironment(environment, sdk.root, hostPlatform, path),
          timeout: Duration.millis(options?.timeoutMs ?? 20_000),
          timeoutBehavior: "timedOutResult",
          ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
          ...(options?.maxOutputBytes === undefined
            ? {}
            : { maxOutputBytes: options.maxOutputBytes }),
        }),
      ),
      Effect.map((result) => ({
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.timedOut ? 124 : Number(result.code ?? 127),
      })),
      Effect.catch((cause) => Effect.succeed({ stdout: "", stderr: String(cause), code: 127 })),
    );

  const toReady = (running: RunningHost): DeviceHost.DeviceHostReady => ({
    hub: {
      origin: running.hub.origin,
      token: running.hub.token,
    } satisfies DeviceHost.DeviceHubEndpoint,
    devices: makeDeviceHubOperations({
      hostId,
      origin: running.hub.origin,
      token: running.hub.token,
      http: httpClient,
      run,
      platformAvailable: (platform) =>
        platformAvailability(platform).pipe(Effect.map((availability) => availability.available)),
      avdsAvailable: currentSdk.pipe(Effect.map((sdk) => sdk.emulator)),
    }),
    nodePath: running.hub.nodePath,
    run,
    helpers: running.helpers,
    ...(running.agentDevice
      ? { releaseAgentSession: releaseAgentDeviceSession(httpClient, running.agentDevice) }
      : {}),
  });

  const current: DeviceHost.DeviceHost["Service"]["current"] = Ref.get(runningRef).pipe(
    Effect.map((running) => (running ? toReady(running) : null)),
  );

  const stopAgent: DeviceHost.DeviceHost["Service"]["stopAgent"] = startLock.withPermits(1)(
    Effect.gen(function* () {
      yield* stopAgentDeviceDaemon;
      yield* Ref.update(runningRef, (running) =>
        running ? { ...running, agentDevice: null } : running,
      );
    }),
  );

  const stop: DeviceHost.DeviceHost["Service"]["stop"] = startLock.withPermits(1)(
    Effect.gen(function* () {
      const running = yield* Ref.getAndSet(runningRef, null);
      // Hub cleanup waits for its exit unbounded; it must not strand the detached agent daemon.
      yield* Effect.all(
        [
          stopHub(running?.hub).pipe(
            Effect.andThen(fs.remove(hubStatePath(), { force: true }).pipe(Effect.ignore)),
          ),
          stopAgentDeviceDaemon,
        ],
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  yield* Effect.addFinalizer(() => stop);

  const host: DeviceHost.DeviceHost["Service"] = {
    id: hostId,
    label: LOCAL_DEVICE_HOST_LABEL,
    summary,
    platformAvailability,
    ensureReady,
    ensureAgentReady,
    current,
    stopAgent,
    stop,
  };
  return host;
});

export const layer = Layer.effect(DeviceHost.DeviceHost, make());

export const __testing = {
  AgentDeviceDaemonFile,
  androidSdk,
  platformReason,
  deviceHostEnvironment,
  hubEnvironment,
};

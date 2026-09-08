/**
 * The device host that is this machine.
 *
 * Runs expo-device-hub as a supervised child on a loopback port and starts the
 * agent-device daemon in HTTP mode under a T3-owned state directory. Both are
 * lazy: nothing is installed or spawned until a device is first listed with
 * the intent to open one, so a server that never touches simulators pays
 * nothing.
 *
 * The hub runs in its standalone mode (origin root). The T3 proxy strips its
 * own prefix, and the Device panel derives stream and socket URLs from the
 * prefix itself rather than from anything the hub prints.
 */
import {
  type DeviceHostSummary,
  type DevicePlatform,
  type DevicePlatformAvailability,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  type AgentDeviceEndpoint,
  type DeviceHost,
  DeviceHostError,
  type DeviceHostReady,
  type DeviceHubEndpoint,
} from "./DeviceHost.ts";
import {
  agentDeviceStateDir,
  type DeviceToolchainPaths,
  ensureDeviceToolchain,
  isDeviceToolchainInstalled,
} from "./DeviceToolchain.ts";

const HUB_READY_TIMEOUT_MS = 30_000;
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MS = 100;
const HUB_RESTART_STABLE_UPTIME_MS = 60_000;
const HUB_RESTART_MAX_DELAY_MS = 30_000;

/**
 * Written beside the agent-device state so a server that dies without running
 * its finalizers (SIGKILL, dev-runner restarts) does not leave a hub bound to
 * a loopback port forever. The next start reads it, kills only a process that
 * is still that hub, and replaces the file.
 */
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
});
const decodeDaemonFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDeviceDaemonFile));

interface HubProcess {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly origin: string;
  readonly startedAtMillis: number;
}

interface RunningHost {
  readonly hub: HubProcess;
  readonly agentDevice: AgentDeviceEndpoint;
  readonly helpers: DeviceHostReady["helpers"];
}

const platformReason = Effect.fn("LocalDeviceHost.platformReason")(function* (
  platform: DevicePlatform,
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const hostPlatform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  if (platform === "ios") {
    if (hostPlatform !== "darwin") return "iOS Simulators need macOS with Xcode.";
    if (!(yield* isCommandAvailable("xcrun"))) return "Xcode command line tools were not found.";
    return null;
  }
  const sdkRoot = environment.ANDROID_HOME?.trim() || environment.ANDROID_SDK_ROOT?.trim();
  if (!sdkRoot && !(yield* isCommandAvailable("adb"))) {
    return "Android SDK was not found. Set ANDROID_HOME or put adb on PATH.";
  }
  return null;
});

export const make = Effect.fn("LocalDeviceHost.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const net = yield* NetService.NetService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;
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
    const platforms = yield* Effect.all([
      platformAvailability("ios"),
      platformAvailability("android"),
    ]);
    return { id: hostId, kind: "local", label: "This machine", platforms };
  });

  const hubEnvironment = (): NodeJS.ProcessEnv => ({
    ...hostEnvironment,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
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

  /**
   * A hub left behind by a previous server is identified by pid plus the
   * command line's entry path, so a recycled pid belonging to something else
   * is never touched.
   */
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
          } catch {
            // Already gone.
          }
        });
      }
    }
    yield* fs.remove(hubStatePath(), { force: true }).pipe(Effect.ignore);
  }).pipe(Effect.catchCause(() => Effect.void));

  const recordHub = (hub: HubProcess, tools: DeviceToolchainPaths) =>
    encodeHubStateFile({
      pid: Number(hub.child.pid),
      port: Number(new URL(hub.origin).port),
      entryPath: tools.hub.entryPath,
    }).pipe(
      Effect.flatMap((json) => fs.writeFileString(hubStatePath(), json)),
      Effect.ignore,
    );

  const spawnHub = Effect.fn("LocalDeviceHost.spawnHub")(function* (
    tools: DeviceToolchainPaths,
  ): Effect.fn.Return<HubProcess, DeviceHostError> {
    yield* reapStaleHub;
    yield* fs
      .makeDirectory(agentDeviceStateDir(path, config.stateDir), { recursive: true })
      .pipe(Effect.ignore);
    const port = yield* net.reserveLoopbackPort("127.0.0.1").pipe(
      Effect.mapError(
        (cause) =>
          new DeviceHostError({
            hostId,
            step: "reserving a port for the device hub",
            detail: cause.message,
            cause,
          }),
      ),
    );
    const origin = `http://127.0.0.1:${port}`;
    const scope = yield* Scope.make("sequential");
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          process.execPath,
          [
            tools.hub.entryPath,
            "--port",
            String(port),
            "--host",
            "127.0.0.1",
            "--hide-sidebar",
            "--hide-boot-device",
          ],
          {
            detached: false,
            shell: false,
            stdout: "pipe",
            stderr: "pipe",
            env: hubEnvironment(),
          },
        ),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new DeviceHostError({
              hostId,
              step: "starting the device hub",
              detail: String(cause),
              cause,
            }),
        ),
      );
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const hub: HubProcess = { child, scope, origin, startedAtMillis };
    yield* Effect.forkIn(observeHubOutput(hub), scope);
    yield* waitForHttpReady({
      baseUrl: origin,
      path: "/readyz",
      timeoutMs: HUB_READY_TIMEOUT_MS,
      makeError: (info) =>
        new DeviceHostError({
          hostId,
          step: "waiting for the device hub to answer",
          detail: `No response from ${info.requestUrl} after ${info.attempt} attempts.`,
          cause: info.cause,
        }),
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.tapError(() => stopHub(hub)),
    );
    yield* recordHub(hub, tools);
    yield* Effect.logInfo("Device hub started", { pid: Number(child.pid), port });
    return hub;
  });

  const observeHubOutput = (hub: HubProcess) =>
    hub.child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) =>
        Effect.logDebug("Device hub output", { pid: Number(hub.child.pid), output: line }),
      ),
      Effect.catchCause(() => Effect.void),
    );

  /**
   * Restart the hub when it dies under us, with the same doubling backoff the
   * relay connector uses so a hub that crashes on boot cannot spin.
   */
  const superviseHub = (hub: HubProcess, tools: DeviceToolchainPaths): Effect.Effect<void> =>
    Effect.gen(function* () {
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
          const replacement = yield* spawnHub(tools);
          yield* Ref.set(runningRef, { ...current, hub: replacement });
          yield* Effect.forkDetach(superviseHub(replacement, tools));
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Device hub supervisor failed", { cause })),
    );

  const daemonFilePath = () => path.join(agentDeviceStateDir(path, config.stateDir), "daemon.json");

  const readDaemonFile = Effect.fn("LocalDeviceHost.readDaemonFile")(function* () {
    const raw = yield* fs.readFileString(daemonFilePath());
    return yield* decodeDaemonFile(raw);
  });

  /**
   * agent-device auto-starts its daemon on any command. A trivial `devices`
   * call in HTTP mode is the documented way to bring it up; its output is the
   * daemon.json this reads back.
   */
  const startAgentDeviceDaemon = Effect.fn("LocalDeviceHost.startAgentDeviceDaemon")(function* (
    tools: DeviceToolchainPaths,
  ): Effect.fn.Return<AgentDeviceEndpoint, DeviceHostError> {
    const stateDir = agentDeviceStateDir(path, config.stateDir);
    yield* fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.ignore);
    const existing = yield* readDaemonFile().pipe(Effect.option);
    const daemonEnvironment: NodeJS.ProcessEnv = {
      ...hostEnvironment,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      // The daemon idles out after five minutes by default; the server owns
      // its lifetime here and stops it explicitly.
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    const toEndpoint = (file: typeof AgentDeviceDaemonFile.Type): AgentDeviceEndpoint => ({
      baseUrl: `http://127.0.0.1:${file.httpPort}`,
      token: file.token,
      entryPath: tools.agentDevice.entryPath,
    });
    if (existing._tag === "Some") {
      const alive = yield* httpClient
        .get(`http://127.0.0.1:${existing.value.httpPort}/health`)
        .pipe(
          Effect.timeout(Duration.seconds(2)),
          Effect.map((response) => response.status === 200),
          Effect.orElseSucceed(() => false),
        );
      if (alive) return toEndpoint(existing.value);
      yield* fs.remove(daemonFilePath(), { force: true }).pipe(Effect.ignore);
    }
    // There is no `daemon start`; the first command in a state dir spawns the
    // daemon and blocks until it answers. `devices` is the cheapest one.
    yield* runner
      .run({
        command: process.execPath,
        args: [tools.agentDevice.entryPath, "devices", "--json"],
        env: daemonEnvironment,
        timeout: Duration.millis(DAEMON_READY_TIMEOUT_MS),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.ignore);
    const deadline = (yield* Clock.currentTimeMillis) + DAEMON_READY_TIMEOUT_MS;
    while (true) {
      const file = yield* readDaemonFile().pipe(Effect.option);
      if (file._tag === "Some") return toEndpoint(file.value);
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new DeviceHostError({
          hostId,
          step: "starting the agent-device daemon",
          detail: `daemon.json did not appear in ${stateDir}.`,
        });
      }
      yield* Effect.sleep(Duration.millis(DAEMON_POLL_MS));
    }
  });

  const stopAgentDeviceDaemon = (tools: DeviceToolchainPaths | null) =>
    tools
      ? runner
          .run({
            command: process.execPath,
            args: [
              tools.agentDevice.entryPath,
              "daemon",
              "stop",
              "--state-dir",
              agentDeviceStateDir(path, config.stateDir),
            ],
            env: { ...hostEnvironment, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" },
            timeout: Duration.seconds(10),
            timeoutBehavior: "timedOutResult",
          })
          .pipe(Effect.ignore)
      : Effect.void;

  let toolsRef: DeviceToolchainPaths | null = null;

  const ensureReady: DeviceHost["ensureReady"] = (onPhase) =>
    startLock.withPermits(1)(
      Effect.gen(function* (): Generator<Effect.Effect<unknown, DeviceHostError>, DeviceHostReady> {
        const running = yield* Ref.get(runningRef);
        if (running) {
          const alive = yield* running.hub.child.isRunning.pipe(Effect.orElseSucceed(() => false));
          if (alive) return toReady(running);
          yield* Ref.set(runningRef, null);
        }
        const installed = yield* isDeviceToolchainInstalled(config.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (!installed) yield* onPhase("installing");
        const tools = yield* ensureDeviceToolchain(config.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.mapError(
            (cause) =>
              new DeviceHostError({
                hostId,
                step: `installing ${cause.tool}`,
                detail: cause.message,
                cause,
              }),
          ),
        );
        toolsRef = tools;
        yield* onPhase("starting");
        const hub = yield* spawnHub(tools);
        const agentDevice = yield* startAgentDeviceDaemon(tools).pipe(
          Effect.tapError(() => stopHub(hub)),
        );
        const candidate = helperPaths(tools);
        const [axExists, cliExists] = yield* Effect.all([
          fs.exists(candidate.serveSimAxSettings).pipe(Effect.orElseSucceed(() => false)),
          fs.exists(candidate.serveSimCli).pipe(Effect.orElseSucceed(() => false)),
        ]);
        const next: RunningHost = {
          hub,
          agentDevice,
          helpers: {
            serveSimAxSettings: axExists ? candidate.serveSimAxSettings : null,
            serveSimCli: cliExists ? candidate.serveSimCli : null,
          },
        };
        yield* Ref.set(runningRef, next);
        yield* Ref.set(restartDelayRef, 0);
        yield* Effect.forkDetach(superviseHub(hub, tools));
        return toReady(next);
      }),
    );

  const helperPaths = (tools: DeviceToolchainPaths) => {
    const serveSimDist = path.join(
      tools.hub.installDir,
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

  const run: DeviceHostReady["run"] = (command, args, options) =>
    runner
      .run({
        command,
        args,
        env: hostEnvironment,
        timeout: Duration.millis(options?.timeoutMs ?? 20_000),
        timeoutBehavior: "timedOutResult",
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
      })
      .pipe(
        Effect.map((result) => ({
          stdout: result.stdout,
          stderr: result.stderr,
          code: Number(result.code),
        })),
        Effect.catch((cause) => Effect.succeed({ stdout: "", stderr: String(cause), code: 127 })),
      );

  const toReady = (running: RunningHost): DeviceHostReady => ({
    hub: { origin: running.hub.origin } satisfies DeviceHubEndpoint,
    agentDevice: running.agentDevice,
    run,
    helpers: running.helpers,
  });

  const current: DeviceHost["current"] = Ref.get(runningRef).pipe(
    Effect.map((running) => (running ? toReady(running) : null)),
  );

  const stop: DeviceHost["stop"] = startLock.withPermits(1)(
    Effect.gen(function* () {
      const running = yield* Ref.getAndSet(runningRef, null);
      yield* stopHub(running?.hub);
      yield* fs.remove(hubStatePath(), { force: true }).pipe(Effect.ignore);
      yield* stopAgentDeviceDaemon(toolsRef);
    }),
  );

  // Never leave the hub or daemon behind when the server's scope closes.
  yield* Effect.addFinalizer(() => stop);

  const host: DeviceHost = {
    id: hostId,
    summary,
    platformAvailability,
    ensureReady,
    current,
    stop,
  };
  return host;
});

/** Exposed for tests. */
export const __testing = { AgentDeviceDaemonFile };

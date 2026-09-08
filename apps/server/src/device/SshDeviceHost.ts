import * as NodeCrypto from "node:crypto";
import {
  type DeviceHostSummary,
  DevicePlatformAvailability,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import { runSshCommand, baseSshArgs, resolveSshCommand } from "@t3tools/ssh/command";
import { NetService } from "@t3tools/shared/Net";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../config.ts";
import {
  DeviceHostError,
  type DeviceHost,
  type DeviceHostReady,
  type DeviceHostAgentReady,
} from "./DeviceHost.ts";
import { quoteRemoteArg, remoteDeviceEnvironment, remoteDeviceScript } from "./sshDeviceScript.ts";

const Probe = Schema.Struct({
  nodePath: Schema.String,
  platforms: Schema.Array(DevicePlatformAvailability),
});
const Started = Schema.Struct({
  ...Probe.fields,
  hubPort: Schema.Int,
  daemonPort: Schema.optionalKey(Schema.Int),
  token: Schema.optionalKey(Schema.String),
  entryPath: Schema.optionalKey(Schema.String),
  helpers: Schema.Struct({
    serveSimAxSettings: Schema.NullOr(Schema.String),
    serveSimCli: Schema.NullOr(Schema.String),
  }),
});
const decodeProbe = Schema.decodeUnknownEffect(Schema.fromJsonString(Probe));
const decodeStarted = Schema.decodeUnknownEffect(Schema.fromJsonString(Started));
const targetFor = (config: SshDeviceHostConfig) => ({
  alias: config.target,
  hostname: config.target,
  username: null,
  port: config.port ?? null,
});
const identityArgs = (config: SshDeviceHostConfig) =>
  config.identityFile ? ["-i", config.identityFile] : [];
const commandArgs = (script: string) => [
  "sh",
  "-c",
  quoteRemoteArg(remoteDeviceEnvironment + script),
];
const failure = (config: SshDeviceHostConfig, step: string) => (cause: unknown) =>
  new DeviceHostError({
    hostId: config.id,
    step,
    cause,
  });
const bootstrap = (
  config: SshDeviceHostConfig,
  owner: string,
  mode: "probe" | "start" | "agent-start" | "stop-agent" | "stop",
) =>
  runSshCommand(targetFor(config), {
    preHostArgs: identityArgs(config),
    remoteCommandArgs: commandArgs(
      'command -v node >/dev/null 2>&1 || { echo "Node is missing from the non-interactive SSH PATH" >&2; exit 1; }; exec node',
    ),
    stdin: remoteDeviceScript(owner, mode),
    timeoutMs: mode === "start" || mode === "agent-start" ? 1_300_000 : 45_000,
  }).pipe(Effect.mapError(failure(config, mode)));

export const probe = Effect.fn("SshDeviceHost.probe")(function* (config: SshDeviceHostConfig) {
  const result = yield* bootstrap(config, "probe", "probe");
  const value = yield* decodeProbe(result.stdout.trim()).pipe(
    Effect.mapError(failure(config, "reading probe result")),
  );
  return {
    id: config.id,
    label: config.label,
    kind: "ssh",
    hubInstalled: false,
    agentDeviceInstalled: false,
    platforms: value.platforms,
  } satisfies DeviceHostSummary;
});

export const make = Effect.fn("SshDeviceHost.make")(function* (
  config: SshDeviceHostConfig,
  onReady: (ready: DeviceHostAgentReady) => Effect.Effect<void, DeviceHostError> = () =>
    Effect.void,
  onStatus: (
    status: "starting" | "ready" | "failed",
    detail?: string,
  ) => Effect.Effect<void> = () => Effect.void,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig;
  const net = yield* NetService;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const parentScope = yield* Scope.Scope;
  const ssh = yield* resolveSshCommand;
  const environmentId = yield* fs
    .readFileString(server.environmentIdPath)
    .pipe(Effect.orElseSucceed(() => server.stateDir));
  const owner = NodeCrypto.createHash("sha256")
    .update(`${environmentId}\0${server.stateDir}\0${config.id}`)
    .digest("hex")
    .slice(0, 24);
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const lock = yield* Semaphore.make(1);
  let stopped = false;
  let activated = false;
  let wantsAgent = false;
  let ready: (DeviceHostReady & { agentDevice?: DeviceHostAgentReady["agentDevice"] }) | null =
    null;
  let connectionScope: Scope.Closeable | null = null;
  let summary: DeviceHostSummary = {
    id: config.id,
    label: config.label,
    kind: "ssh",
    hubInstalled: false,
    agentDeviceInstalled: false,
    platforms: [],
  };

  const run: DeviceHostReady["run"] = (command, args, options) =>
    provide(
      runSshCommand(targetFor(config), {
        preHostArgs: identityArgs(config),
        remoteCommandArgs: commandArgs(`exec ${[command, ...args].map(quoteRemoteArg).join(" ")}`),
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
    ).pipe(
      Effect.map((result) => ({ ...result, code: 0 })),
      Effect.catch((error) =>
        Effect.succeed({
          stdout: "stdout" in error ? (error.stdout ?? "") : "",
          stderr: error.message,
          code: "exitCode" in error ? (error.exitCode ?? 127) : 127,
        }),
      ),
    );

  const connect = Effect.fn("SshDeviceHost.connect")(function* (): Effect.fn.Return<
    DeviceHostReady & { agentDevice?: DeviceHostAgentReady["agentDevice"] },
    DeviceHostError
  > {
    activated = true;
    const result = yield* provide(bootstrap(config, owner, wantsAgent ? "agent-start" : "start"));
    yield* onStatus("starting");
    const remote = yield* decodeStarted(result.stdout.trim()).pipe(
      Effect.mapError(failure(config, "reading host endpoints")),
    );
    summary = {
      ...summary,
      platforms: remote.platforms,
      hubInstalled: true,
      agentDeviceInstalled: wantsAgent || summary.agentDeviceInstalled,
    };
    const hubPort = yield* net
      .reserveLoopbackPort("127.0.0.1")
      .pipe(Effect.mapError(failure(config, "reserving hub port")));
    const daemonPort = yield* net
      .reserveLoopbackPort("127.0.0.1")
      .pipe(Effect.mapError(failure(config, "reserving daemon port")));
    const scope = yield* Scope.make();
    connectionScope = scope;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          ssh,
          [
            ...baseSshArgs(targetFor(config), { batchMode: "yes" }),
            ...identityArgs(config),
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
            "-N",
            "-L",
            `127.0.0.1:${hubPort}:127.0.0.1:${remote.hubPort}`,
            ...(remote.daemonPort === undefined
              ? []
              : ["-L", `127.0.0.1:${daemonPort}:127.0.0.1:${remote.daemonPort}`]),
            config.target,
          ],
          { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
        ),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(failure(config, "forwarding ports")),
      );
    let stderr = "";
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderr = (stderr + chunk).slice(-2000);
        }),
      ),
      Effect.forkIn(scope),
    );
    const next = {
      nodePath: remote.nodePath,
      hub: { origin: `http://127.0.0.1:${hubPort}` },
      ...(remote.daemonPort !== undefined &&
      remote.token !== undefined &&
      remote.entryPath !== undefined
        ? {
            agentDevice: {
              baseUrl: `http://127.0.0.1:${daemonPort}`,
              token: remote.token,
              entryPath: remote.entryPath,
            },
          }
        : {}),
      helpers: remote.helpers,
      run,
    };
    for (const [baseUrl, route] of [
      [next.hub.origin, "/readyz"],
      ...(next.agentDevice ? [[next.agentDevice.baseUrl, "/health"]] : []),
    ]) {
      yield* waitForHttpReady({
        baseUrl: baseUrl!,
        path: route!,
        timeoutMs: 15000,
        makeError: () =>
          failure(
            config,
            "waiting for SSH forward",
          )(stderr || "Forwarded endpoint did not answer."),
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    }
    if (next.agentDevice) yield* onReady({ ...next, agentDevice: next.agentDevice });
    ready = next;
    yield* onStatus("ready");
    // Reconnect also repairs helpers that died while SSH itself stayed connected.
    const unhealthy = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("10 seconds");
        const alive = yield* http.get(`${next.hub.origin}/readyz`).pipe(
          Effect.timeout("5 seconds"),
          Effect.map((r) => r.status === 200),
          Effect.orElseSucceed(() => false),
        );
        const daemonAlive = next.agentDevice
          ? yield* http.get(`${next.agentDevice!.baseUrl}/health`).pipe(
              Effect.timeout("5 seconds"),
              Effect.map((r) => r.status === 200),
              Effect.orElseSucceed(() => false),
            )
          : true;
        if (!alive || !daemonAlive) return;
      }
    });
    yield* Effect.gen(function* () {
      yield* Effect.raceFirst(child.exitCode.pipe(Effect.ignore), unhealthy);
      if (stopped || connectionScope !== scope) return;
      ready = null;
      yield* onStatus("starting", "Reconnecting to device host…");
      yield* Scope.close(scope, Exit.void);
      let delay = 1000;
      while (true) {
        if (stopped || connectionScope !== scope) return;
        yield* Effect.sleep(delay);
        const result = yield* lock
          .withPermit(
            Effect.suspend(() => (stopped || ready ? Effect.void : connect().pipe(Effect.asVoid))),
          )
          .pipe(Effect.result);
        if (result._tag === "Success") return;
        yield* onStatus("failed", result.failure.message);
        if (connectionScope && connectionScope !== scope)
          yield* Scope.close(connectionScope, Exit.void);
        connectionScope = scope;
        delay = Math.min(delay * 2, 30000);
      }
    }).pipe(Effect.forkIn(parentScope));
    return next;
  });

  const ensureReady: DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    lock.withPermit(
      Effect.gen(function* () {
        stopped = false;
        if (ready) return ready;
        summary = yield* provide(probe(config));
        yield* onPhase("installing");
        return yield* connect().pipe(
          Effect.tapError(() =>
            connectionScope ? Scope.close(connectionScope, Exit.void) : Effect.void,
          ),
        );
      }),
    );
  const stop = lock.withPermit(
    Effect.gen(function* () {
      stopped = true;
      ready = null;
      if (connectionScope) yield* Scope.close(connectionScope, Exit.void);
      connectionScope = null;
      if (activated) yield* provide(bootstrap(config, owner, "stop")).pipe(Effect.ignore);
      activated = false;
      wantsAgent = false;
    }),
  );
  const changeAgent = (enabled: boolean) =>
    lock.withPermit(
      Effect.gen(function* () {
        wantsAgent = enabled;
        if (enabled && ready?.agentDevice) return { ...ready, agentDevice: ready.agentDevice };
        if (!enabled && !ready?.agentDevice) return null;
        ready = null;
        const previousScope = connectionScope;
        connectionScope = null;
        if (previousScope) yield* Scope.close(previousScope, Exit.void);
        if (!enabled) yield* provide(bootstrap(config, owner, "stop-agent"));
        return yield* connect();
      }),
    );
  yield* Effect.addFinalizer(() => stop);
  return {
    id: config.id,
    summary: Effect.sync(() => summary),
    current: Effect.sync(() => ready),
    ensureReady,
    ensureAgentReady: () =>
      changeAgent(true).pipe(
        Effect.flatMap((value) =>
          value?.agentDevice
            ? Effect.succeed({ ...value, agentDevice: value.agentDevice })
            : Effect.fail(failure(config, "starting agent tools")("Daemon endpoint missing")),
        ),
      ),
    stopAgent: changeAgent(false).pipe(Effect.asVoid, Effect.ignore),
    stop,
    platformAvailability: (platform) =>
      provide(probe(config)).pipe(
        Effect.map((value) => {
          summary = value;
          return value.platforms.find((p) => p.platform === platform)!;
        }),
        Effect.orElseSucceed(() => ({
          platform,
          available: false,
          reason: "Cannot reach device host. Test its SSH connection in Settings.",
        })),
      ),
  } satisfies DeviceHost["Service"];
});

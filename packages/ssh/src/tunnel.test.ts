import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { DesktopSshEnvironmentBootstrapSchema } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { remoteStateKey } from "./command.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const decodeBootstrap = Schema.decodeUnknownEffect(DesktopSshEnvironmentBootstrapSchema);

const makeReconnectHarness = (beforeStop: () => Effect.Effect<void> = () => Effect.void) => {
  const config = { port: 40_001, username: "original" };
  const tunnelCommands: Array<ReadonlyArray<string>> = [];
  const stopCommands: Array<ReadonlyArray<string>> = [];
  const activeTunnels = new Set<number>();
  const remoteOwners = new Set<string>();
  const launchedOwners: string[] = [];
  const pairedOwners: string[] = [];
  let nextTunnelId = 0;
  let failLaunch = false;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = commandArgs(command);
      if (args.includes("-G")) {
        return makeSuccessfulProcess(
          `hostname 127.0.0.1\nuser ${config.username}\nport ${config.port}\n`,
        );
      }
      if (args.includes("-N")) {
        tunnelCommands.push(args);
        const id = ++nextTunnelId;
        activeTunnels.add(id);
        return makeRunningProcess(() => {
          activeTunnels.delete(id);
        });
      }
      if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
        const stateKey = args.at(-1)!;
        launchedOwners.push(stateKey);
        if (failLaunch) {
          failLaunch = false;
          return {
            ...makeSuccessfulProcess("remote launch unavailable"),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          };
        }
        remoteOwners.add(stateKey);
        return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}\n');
      }
      const input = ChildProcess.isStandardCommand(command) ? command.options.stdin : undefined;
      const stdin = typeof input === "object" && "stream" in input ? input.stream : input;
      const script = Stream.isStream(stdin)
        ? yield* stdin.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          )
        : "";
      const stateKey = script.match(/STATE_DIR="\$HOME\/\.t3\/ssh-launch\/([^"]+)"/u)?.[1];
      assert.isDefined(stateKey);
      if (script.includes("auth pairing create")) {
        pairedOwners.push(stateKey!);
        return makeSuccessfulProcess('{"credential":"test-pairing-token"}\n');
      }
      assert.include(script, '{"stopped":true}');
      stopCommands.push(args);
      yield* beforeStop();
      remoteOwners.delete(stateKey!);
      return makeSuccessfulProcess('{"stopped":true}\n');
    }),
  );
  return {
    config,
    tunnelCommands,
    stopCommands,
    activeTunnels,
    remoteOwners,
    launchedOwners,
    pairedOwners,
    failNextLaunch: () => {
      failLaunch = true;
    },
    layer: Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.SshPasswordPrompt.disabledLayer,
      SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
    ),
  };
};

describe("ssh tunnel scripts", () => {
  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(
    ["local tunnel", "remote server"].flatMap((stalledStep) =>
      [false, true].map((rotate) => ({ stalledStep, rotate })),
    ),
  )(
    "waits for $stalledStep shutdown before reconnecting (port changes: $rotate)",
    ({ stalledStep, rotate }) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        let configOutput = "";
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              return makeSuccessfulProcess(configOutput);
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target), {
            startImmediately: true,
          });
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target), {
            startImmediately: true,
          });
          if (rotate) configOutput = "port 2222\n";

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
          assert.equal(first.target.port, rotate ? 2222 : null);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );

  it.effect.each(
    [
      { name: "SSH config", username: null, port: null },
      { name: "an explicit username", username: "override", port: null },
      { name: "an explicit port", username: null, port: 2200 },
      { name: "explicit username and port", username: "override", port: 2200 },
    ].flatMap((overrides) => ["manual", "automatic"].map((mode) => ({ ...overrides, mode }))),
  )("reconnects a saved target using $name after a config change ($mode)", (overrides) => {
    const harness = makeReconnectHarness();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment({
        alias: "devbox",
        hostname: "devbox",
        username: overrides.username ?? harness.config.username,
        port: overrides.port ?? harness.config.port,
      });
      const first = yield* manager.ensureEnvironment({
        alias: "devbox",
        hostname: "devbox",
        username: overrides.username,
        port: overrides.port,
      });
      assert.lengthOf(harness.tunnelCommands, 1);
      harness.config.port = 40_002;
      harness.config.username = "updated";
      const saved = yield* decodeBootstrap(JSON.parse(JSON.stringify(first)));
      if (overrides.mode === "manual") {
        yield* manager.disconnectEnvironment(saved.target);
        assert.equal(harness.activeTunnels.size, 0);
        assert.equal(harness.remoteOwners.size, 0);
        const originalStop = harness.stopCommands.at(-1)!;
        assert.equal(originalStop[originalStop.indexOf("-p") + 1], String(first.target.port));
        assert.include(originalStop, `${first.target.username}@devbox`);
      }
      const reconnected = yield* manager.ensureEnvironment(saved.target, {
        issuePairingToken: true,
      });
      const username = overrides.username ?? harness.config.username;
      const port = overrides.port ?? harness.config.port;
      assert.equal(reconnected.target.username, username);
      assert.equal(reconnected.target.port, port);
      assert.deepEqual(reconnected.target.overrides, {
        username: overrides.username,
        port: overrides.port,
      });
      assert.equal(harness.activeTunnels.size, 1);
      assert.equal(harness.remoteOwners.size, 1);
      assert.deepEqual(harness.pairedOwners, [harness.launchedOwners.at(-1)]);
      if (overrides.mode === "automatic") {
        assert.equal(harness.launchedOwners.at(-1), harness.launchedOwners[0]);
        assert.lengthOf(harness.stopCommands, 0);
      }
      const tunnel = harness.tunnelCommands.at(-1)!;
      assert.equal(tunnel[tunnel.indexOf("-p") + 1], String(port));
      assert.include(tunnel, `${username}@devbox`);
      yield* manager.disconnectEnvironment(saved.target);
      const stop = harness.stopCommands.at(-1)!;
      assert.equal(stop[stop.indexOf("-p") + 1], String(port));
      assert.include(stop, `${username}@devbox`);
      assert.equal(harness.activeTunnels.size, 0);
      assert.equal(harness.remoteOwners.size, 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("keeps remote ownership when a replacement fails before retrying", () => {
    const harness = makeReconnectHarness();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const first = yield* manager.ensureEnvironment({
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      });
      harness.config.port = 40_002;
      harness.failNextLaunch();
      const failure = yield* Effect.result(manager.ensureEnvironment(first.target));
      assert.isTrue(Result.isFailure(failure));
      assert.equal(harness.activeTunnels.size, 1);
      assert.equal(harness.remoteOwners.size, 1);
      const retried = yield* manager.ensureEnvironment(first.target);
      assert.equal(retried.target.port, 40_002);
      assert.equal(harness.activeTunnels.size, 1);
      assert.equal(new Set(harness.launchedOwners).size, 1);
      yield* manager.disconnectEnvironment(first.target);
      assert.equal(harness.activeTunnels.size, 0);
      assert.equal(harness.remoteOwners.size, 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("closes all hosts concurrently when the manager shuts down", () =>
    Effect.gen(function* () {
      const firstStop = yield* Deferred.make<void>();
      const finishStops = yield* Deferred.make<void>();
      let stopsStarted = 0;
      const harness = makeReconnectHarness(() =>
        Effect.gen(function* () {
          stopsStarted += 1;
          yield* Deferred.succeed(firstStop, undefined);
          yield* Deferred.await(finishStops);
        }),
      );
      yield* Effect.gen(function* () {
        const shutdown = yield* Effect.forkChild(
          Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            for (const alias of ["alpha", "beta"]) {
              yield* manager.ensureEnvironment({
                alias,
                hostname: alias,
                username: null,
                port: null,
              });
            }
          }).pipe(Effect.provide(harness.layer), Effect.scoped),
        );
        yield* Effect.raceFirst(Deferred.await(firstStop), Fiber.join(shutdown));
        yield* TestClock.adjust(Duration.zero);
        const startedBeforeRelease = stopsStarted;
        yield* Deferred.succeed(finishStops, undefined);
        yield* Fiber.join(shutdown);
        assert.equal(startedBeforeRelease, 2);
        assert.equal(harness.activeTunnels.size, 0);
        assert.equal(harness.remoteOwners.size, 0);
      }).pipe(Effect.ensuring(Deferred.succeed(finishStops, undefined)));
    }),
  );

  it.effect.each(["connect", "disconnect"] as const)(
    "uses saved ownership with a new manager and port during %s",
    (operation) => {
      const harness = makeReconnectHarness();
      return Effect.gen(function* () {
        const saved = {
          alias: "devbox",
          hostname: "127.0.0.1",
          username: "original",
          port: 40001,
          overrides: { username: null, port: null },
        };
        harness.remoteOwners.add(yield* remoteStateKey(saved));
        harness.config.port = 40002;
        const manager = yield* SshTunnel.SshEnvironmentManager;
        if (operation === "connect") {
          const restored = yield* manager.ensureEnvironment(saved);
          assert.equal(restored.target.port, 40002);
          assert.equal(harness.remoteOwners.size, 1);
        }
        yield* manager.disconnectEnvironment(saved);
        const stop = harness.stopCommands.at(-1)!;
        assert.equal(stop[stop.indexOf("-p") + 1], "40002");
        assert.equal(harness.activeTunnels.size, 0);
        assert.equal(harness.remoteOwners.size, 0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    },
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

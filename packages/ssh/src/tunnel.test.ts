import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
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

  it.effect.each(["resolution", "pairing"] as const)(
    "interrupts pending %s when the manager closes",
    (stage) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const pause = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        let launches = 0;
        let kills = 0;
        let stops = 0;
        let pairingStarted = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            if (args.includes("-G")) {
              if (stage === "resolution") return yield* pause;
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              return makeRunningProcess(() => {
                kills += 1;
              });
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              launches += 1;
              return makeSuccessfulProcess(
                '{"remotePort":3773,"serverKind":"managed","launched":true}',
              );
            }
            if (!pairingStarted) {
              pairingStarted = true;
              return { ...makeSuccessfulProcess(""), exitCode: pause };
            }
            stops += 1;
            return makeSuccessfulProcess('{"stopped":true}');
          }),
        );
        const services = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
        );
        yield* Effect.gen(function* () {
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
          const context = yield* Layer.buildWithScope(
            SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
            scope,
          );
          const manager = yield* SshTunnel.SshEnvironmentManager.pipe(Effect.provide(context));
          const request = yield* Effect.forkChild(
            manager.ensureEnvironment(
              { alias: "devbox", hostname: "devbox", username: null, port: null },
              { issuePairingToken: stage === "pairing" },
            ),
          );
          yield* Deferred.await(started);
          yield* Scope.close(scope, Exit.void);
          yield* TestClock.adjust(Duration.zero);
          const exit = request.pollUnsafe();
          // Dispose the caller even when the manager failed to interrupt it.
          yield* Fiber.interrupt(request);
          assert.isDefined(exit, "manager shutdown must settle the pending caller");
          assert.isTrue(exit !== undefined && Exit.hasInterrupts(exit));
          assert.equal(launches, stage === "pairing" ? 1 : 0);
          assert.equal(kills, launches);
          assert.equal(stops, launches);
        }).pipe(Effect.provide(services), Effect.scoped);
      }),
  );

  it.effect.each([
    { name: "fresh managed", serverKind: "managed", launched: true, expectedStops: 1 },
    { name: "external", serverKind: "external", launched: undefined, expectedStops: 0 },
    { name: "reused managed", serverKind: "managed", launched: undefined, expectedStops: 0 },
  ] as const)(
    "cleans up only owned servers when cancelling port reservation after a $name launch",
    ({ serverKind, launched, expectedStops }) =>
      Effect.gen(function* () {
        const reserving = yield* Deferred.make<void>();
        let launches = 0;
        let forwards = 0;
        let stops = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G")) return makeSuccessfulProcess("");
            if (args.includes("-N")) {
              forwards += 1;
              return makeRunningProcess(() => undefined);
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              launches += 1;
              return makeSuccessfulProcess(
                JSON.stringify({ remotePort: 3773, serverKind, launched }),
              );
            }
            stops += 1;
            return makeSuccessfulProcess('{"stopped":true}');
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, {
            ...testNetService,
            reserveLoopbackPort: () =>
              Deferred.succeed(reserving, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const request = yield* Effect.forkChild(
            manager.ensureEnvironment({
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
            }),
          );
          yield* Deferred.await(reserving);
          yield* Fiber.interrupt(request);
          assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(request)));
          assert.equal(launches, 1);
          assert.equal(forwards, 0);
          assert.equal(stops, expectedStops);
        }).pipe(Effect.provide(layer), Effect.scoped);
        assert.equal(stops, expectedStops);
      }),
  );

  it.effect("releases caller-cancelled readiness and shares the next healthy tunnel", () =>
    Effect.gen(function* () {
      const probing = yield* Deferred.make<void>();
      let probes = 0;
      let forwards = 0;
      let kills = 0;
      let stops = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-G")) return makeSuccessfulProcess("");
          if (args.includes("-N")) {
            forwards += 1;
            return makeRunningProcess(() => {
              kills += 1;
            });
          }
          if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
            return makeSuccessfulProcess(
              '{"remotePort":3773,"serverKind":"managed","launched":true}',
            );
          }
          stops += 1;
          return makeSuccessfulProcess('{"stopped":true}');
        }),
      );
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (++probes === 1) {
            yield* Deferred.succeed(probing, undefined);
            return yield* Effect.never;
          }
          return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const request = yield* Effect.forkChild(manager.ensureEnvironment(target));
        yield* Deferred.await(probing);
        yield* Fiber.interrupt(request);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(request)));
        assert.equal(kills, 1);
        assert.equal(stops, 1);
        const [first, second] = yield* Effect.all(
          [manager.ensureEnvironment(target), manager.ensureEnvironment(target)],
          { concurrency: "unbounded" },
        );
        assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        assert.equal(forwards, 2);
        assert.equal(kills, 1);
        assert.equal(stops, 1, "successful setup transfers cleanup until manager shutdown");
      }).pipe(Effect.provide(layer), Effect.scoped);
      assert.equal(kills, 2);
      assert.equal(stops, 2);
    }),
  );

  it.effect.each([
    { mode: "successful stop", closeManager: false },
    { mode: "failed stop", closeManager: false },
    { mode: "successful stop", closeManager: true },
    { mode: "failed stop", closeManager: true },
  ] as const)(
    "closes the tunnel scope after a $mode (manager shutdown: $closeManager)",
    ({ mode, closeManager }) =>
      Effect.gen(function* () {
        const stopStarted = yield* Deferred.make<void>();
        const finishStop = yield* Deferred.make<void>();
        const pauseStop = Deferred.succeed(stopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishStop)),
        );
        const spawnedCommands: Array<ReadonlyArray<string>> = [];
        let tunnelKillCount = 0;
        let stopCommandCount = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            spawnedCommands.push(args);
            if (args.includes("-N")) {
              return makeRunningProcess(() => {
                tunnelKillCount += 1;
              });
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              return makeSuccessfulProcess(
                '{"remotePort":3773,"serverKind":"managed","launched":true}\n',
              );
            }
            if (args.includes("sh")) {
              stopCommandCount += 1;
              if (mode === "failed stop" && stopCommandCount === 1) {
                return {
                  ...makeSuccessfulProcess(""),
                  exitCode: (closeManager ? pauseStop : Effect.void).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(1)),
                  ),
                  stderr: Stream.make(
                    new TextEncoder().encode("Remote T3 server did not stop within 2 seconds.\n"),
                  ),
                };
              }
              return {
                ...makeSuccessfulProcess('{"stopped":true}\n'),
                exitCode: (closeManager && stopCommandCount === 1 ? pauseStop : Effect.void).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }
            return makeSuccessfulProcess("\n");
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
        );
        const target = {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        } as const;

        yield* Effect.gen(function* () {
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
          const context = yield* Layer.buildWithScope(
            SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
            scope,
          );
          const manager = yield* SshTunnel.SshEnvironmentManager.pipe(Effect.provide(context));

          const first = yield* manager.ensureEnvironment(target);
          assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
          const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
          assert.isDefined(firstTunnelArgs);
          assert.include(firstTunnelArgs, "ControlMaster=no");
          assert.include(firstTunnelArgs, "ControlPath=none");
          assert.include(firstTunnelArgs, "ControlPersist=no");
          assert.deepEqual(firstTunnelArgs?.slice(-2), ["--", "julius@devbox"]);

          assert.equal(stopCommandCount, 0, "successful setup must retain its remote server");
          const disconnect = yield* Effect.forkChild(
            Effect.result(manager.disconnectEnvironment(target)),
          );
          if (closeManager) {
            yield* Deferred.await(stopStarted);
            yield* Scope.close(scope, Exit.void);
            yield* TestClock.adjust(Duration.zero);
            const exit = disconnect.pollUnsafe();
            yield* Deferred.succeed(finishStop, undefined);
            assert.isUndefined(exit, "manager shutdown must leave the caller-owned stop running");
          }
          const disconnectExit = yield* Fiber.await(disconnect);
          assert.isTrue(
            Exit.isSuccess(disconnectExit),
            "disconnect must deliver its result to the caller",
          );
          if (!Exit.isSuccess(disconnectExit)) return;
          const disconnected = disconnectExit.value;
          if (mode === "failed stop") {
            assert.isTrue(Result.isFailure(disconnected));
            if (Result.isFailure(disconnected)) {
              assert.instanceOf(disconnected.failure, SshCommandError);
              assert.equal(
                disconnected.failure.message,
                "Remote T3 server did not stop within 2 seconds.",
              );
            }
          } else {
            assert.isTrue(Result.isSuccess(disconnected));
          }
          assert.equal(tunnelKillCount, 1);
          assert.equal(stopCommandCount, 1);

          if (closeManager) return;

          if (mode === "failed stop") {
            yield* manager.disconnectEnvironment(target);
            assert.equal(tunnelKillCount, 1);
            assert.equal(stopCommandCount, 2);
          }

          yield* manager.ensureEnvironment(target);

          assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
          assert.equal(tunnelKillCount, 1);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishStop, undefined)),
          Effect.provide(layer),
          Effect.scoped,
          Effect.andThen(
            Effect.sync(() => {
              assert.equal(tunnelKillCount, closeManager ? 1 : 2);
              assert.equal(stopCommandCount, closeManager ? 1 : mode === "failed stop" ? 3 : 2);
            }),
          ),
        );
      }),
  );

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      let stops = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const input = command._tag === "StandardCommand" ? command.options.stdin : undefined;
          if (
            input &&
            typeof input === "object" &&
            "stream" in input &&
            Stream.isStream(input.stream)
          ) {
            const script = yield* input.stream.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (text, chunk) => text + chunk,
              ),
            );
            if (script.includes(`printf '{"stopped":true}`)) stops += 1;
          }
          return commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed","launched":true}\n');
        }),
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
        assert.equal(stops, 1, "failed readiness must stop the acknowledged managed server");
      }).pipe(Effect.provide(layer), Effect.scoped);
      assert.equal(stops, 1);
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

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
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
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

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
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

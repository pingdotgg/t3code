import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
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

describe("ssh tunnel scripts", () => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "pairs against the remote custom home instead of creating credentials in ~/.t3",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-home-test-" });
        const customHome = path.join(directory, "Custom T3 home");
        const cli = path.join(directory, "pairing-fixture.cjs");
        yield* fs.writeFileString(
          cli,
          `const args = process.argv.slice(2);
process.stdout.write(args[0] === "__ssh-helper"
  ? process.env.T3CODE_HOME
  : JSON.stringify({ credential: args[args.indexOf("--base-dir") + 1] }));`,
        );
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const localSsh = ChildProcessSpawner.make((command) => {
          assert.strictEqual(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return realSpawner.spawn(command);
          return realSpawner.spawn(
            ChildProcess.make("/bin/sh", ["-s"], {
              ...command.options,
              env: {
                HOME: directory,
                PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
                T3CODE_HOME: customHome,
              },
              extendEnv: false,
            }),
          );
        });
        const paired = yield* SshTunnel.issueRemotePairingToken(
          { alias: "fixture", hostname: "fixture", username: null, port: null },
          undefined,
          { nodeScriptPath: cli },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, localSsh));
        assert.strictEqual(paired.credential, customHome);
        const stateKey = yield* remoteStateKey({
          alias: "fixture",
          hostname: "fixture",
          username: null,
          port: null,
        });
        const launchedHome = path.join(directory, "Home selected by the login shell");
        yield* fs.writeFileString(
          path.join(directory, ".t3/ssh-launch", stateKey, "server-home"),
          launchedHome,
        );
        const pairedAgain = yield* SshTunnel.issueRemotePairingToken(
          { alias: "fixture", hostname: "fixture", username: null, port: null },
          undefined,
          { nodeScriptPath: cli },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, localSsh));
        assert.strictEqual(pairedAgain.credential, launchedHome);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "adopts the custom-home service and leaves a live old-home managed server untouched",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-launch-test-" });
        const customHome = path.join(directory, "custom home");
        const target = { alias: "fixture", hostname: "fixture", username: null, port: null };
        const stateKey = yield* remoteStateKey(target);
        const stateDir = path.join(directory, ".t3/ssh-launch", stateKey);
        const archiveDir = path.join(directory, ".t3/runtime/versions", ARCHIVE.archiveVersion);
        yield* fs.makeDirectory(archiveDir, { recursive: true });
        yield* fs.makeDirectory(path.join(customHome, "userdata"), { recursive: true });
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // This fixture owns its PID. Even a broken ownership guard cannot signal
        // the test runner or a real T3 environment.
        const external = yield* realSpawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "process.stdin.resume()"]),
        );
        yield* fs.writeFileString(
          path.join(customHome, "userdata/server-runtime.json"),
          JSON.stringify({ pid: external.pid, port: 41773 }),
        );
        yield* fs.writeFileString(
          path.join(archiveDir, ".install-complete"),
          ARCHIVE.archiveVersion,
        );
        yield* fs.writeFileString(
          path.join(archiveDir, "t3"),
          `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "__ssh-helper") process.exit(21);
switch (args[1]) {
  case "home-dir": process.stdout.write(process.env.T3CODE_HOME); break;
  case "runtime-port": {
    const runtime = JSON.parse(fs.readFileSync(args[2], "utf8"));
    process.stdout.write(runtime.pid + " " + runtime.port); break;
  }
  case "wait-ready": process.exit(args[2] === process.env.T3_FIXTURE_READY_PORT ? 0 : 22); break;
  default: process.exit(23);
}`,
          { mode: 0o700 },
        );
        yield* fs.writeFileString(
          path.join(directory, "ps"),
          '#!/bin/sh\nif [ "$T3_FIXTURE_ZOMBIE" = "1" ]; then printf Z; else exec /bin/ps "$@"; fi\n',
          { mode: 0o700 },
        );
        let zombie = "0";
        let readyPort = "41773";
        const localSsh = ChildProcessSpawner.make((command) => {
          assert.strictEqual(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return realSpawner.spawn(command);
          return realSpawner.spawn(
            ChildProcess.make("/bin/sh", ["-s", "--", stateKey], {
              ...command.options,
              env: {
                HOME: directory,
                PATH: `${directory}:/usr/bin:/bin`,
                T3_FIXTURE_ZOMBIE: zombie,
                T3CODE_HOME: customHome,
                T3_FIXTURE_READY_PORT: readyPort,
              },
              extendEnv: false,
            }),
          );
        });
        const launch = SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, localSsh),
        );
        assert.deepEqual(yield* launch, { remotePort: 41773, remoteServerKind: "external" });
        assert.strictEqual(
          (yield* fs.readFileString(path.join(stateDir, "server-home"))).trim(),
          customHome,
        );
        assert.isTrue(yield* external.isRunning);

        // A responsive port remembered for the old home cannot stand in for
        // an unresponsive service in the newly selected home.
        readyPort = "41666";
        yield* fs.remove(path.join(stateDir, "server-home"));
        yield* fs.writeFileString(path.join(stateDir, "port"), readyPort);
        assert.isTrue(Result.isFailure(yield* Effect.result(launch)));
        assert.isFalse(yield* fs.exists(path.join(stateDir, "server-home")));
        assert.isTrue(yield* external.isRunning);

        // Legacy ownership has no server-home file and belongs to ~/.t3.
        yield* fs.writeFileString(path.join(stateDir, "managed"), "managed");
        yield* fs.writeFileString(path.join(stateDir, "pid"), String(external.pid));
        yield* fs.writeFileString(path.join(stateDir, "run-t3.sh"), "old runner stays intact");
        const refused = yield* Effect.result(launch);
        assert.isTrue(Result.isFailure(refused));
        if (Result.isFailure(refused))
          assert.include(refused.failure.message, "Stop it before changing the T3 home");
        assert.isTrue(yield* external.isRunning);
        assert.strictEqual(
          yield* fs.readFileString(path.join(stateDir, "run-t3.sh")),
          "old runner stays intact",
        );
        zombie = "1";
        readyPort = "41773";
        assert.deepEqual(yield* launch, { remotePort: 41773, remoteServerKind: "external" });
        assert.isTrue(yield* external.isRunning);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

import * as NodeNet from "node:net";

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
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

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

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
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
const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

describe("ssh tunnel scripts", () => {
  it("installs and runs the release archive without Node, npm, or npx", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(script, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/pingdotgg/t3code/releases/download'",
    );
    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"');
    assert.include(script, 'T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$T3_RUNTIME_DIR/t3" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    assert.include(
      script,
      'T3_LOCK="$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
    );
    assert.include(script, 'if ! kill -0 "$T3_LOCK_OWNER" 2>/dev/null; then');
    assert.include(script, 'if [ "$T3_LOCK_UNOWNED" -ge 5 ]; then');
    assert.include(script, 'if [ "$T3_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$T3_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$T3_STAGING/$T3_ARCHIVE" 240');
    assert.notInclude(script, "T3_LOCK_CANDIDATE");
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! t3_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$T3_STAGING/t3" --version'),
      script.indexOf('> "$T3_STAGING/.install-complete"'),
    );
    assert.equal(script.split("ensure_remote_node_path || true").length - 1, 1);
    assert.isBelow(
      script.indexOf("ensure_remote_node_path || true"),
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
    );
    assert.isBelow(
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("T3_ARCHIVE_VERSION="),
    );

    const launch = SshTunnel.buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/t3/",
    });
    assert.include(launch, "T3_ARCHIVE_MODE=1");
    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
    assert.include(SshTunnel.buildRemoteLaunchScript(NODE_SCRIPT), "T3_ARCHIVE_MODE=0");
  });

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

  it("refuses to build a runner with neither an archive version nor a node script", () => {
    for (const input of [undefined, {}, { archiveVersion: "  " }, { nodeScriptPath: null }]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript(input),
        SshTunnel.SshMissingRunnerError,
      );
    }
    assert.throws(() => SshTunnel.buildRemoteLaunchScript(), SshTunnel.SshMissingRunnerError);
  });

  it("does not hard-code a remote node engine range", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(NODE_SCRIPT);

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
    assert.include(script, "T3_ARCHIVE_VERSION=''");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"');
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
    assert.notInclude(script, "npx");
  });

  it("embeds the runner in the launch script byte for byte", () => {
    const runner = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);
    assert.include(SshTunnel.buildRemoteLaunchScript(ARCHIVE), runner);
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const stateKey = "711bc738002d72fd";
    const launch = SshTunnel.buildRemoteLaunchScript(ARCHIVE);
    const devLaunch = SshTunnel.buildRemoteLaunchScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(
      launch,
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && server_running "$REMOTE_PID"',
    );
    assert.include(launch, "RUNNER_CHANGED=1");
    assert.include(launch, "ensure_remote_node_path()");
    assert.include(launch, "if ! ensure_remote_node_path; then");
    assert.include(devLaunch, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(devLaunch, "does not satisfy required range ");
    assert.include(launch, 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(launch, "wait_ready");
    assert.include(launch, '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(launch, '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(launch, "server-home");
    assert.include(launch, "Remote T3 server did not become ready");
    assert.include(launch, 'wait_ready "60000"');
    assert.include(launch, 'if [ -s "$LOG_FILE" ]; then');
    assert.include(launch, "It wrote nothing to %s");
    assert.include(launch, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"',
    );
    assert.notInclude(SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE), "server-home");
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'kill "$REMOTE_PID" 2>/dev/null || true',
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"',
    );
    assert.include(
      launch,
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(launch, "resolve_default_runtime_port()");
    assert.include(launch, 'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port');
    assert.include(launch, "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))");
    assert.include(
      launch,
      'if [ -n "$DEFAULT_REMOTE_PORT" ] && [ "$REMOTE_MANAGED" = "managed" ] && [ "$DEFAULT_RUNTIME_PID" = "$REMOTE_PID" ]; then',
    );
    assert.include(launch, 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(launch, 'rm -f "$PID_FILE"');
    assert.include(launch, "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(launch, 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      launch.indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      launch.indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      launch.indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      launch.indexOf('elif [ -n "$REMOTE_PID" ]'),
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

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, NODE_SCRIPT),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("gives cold archive launches a larger budget than node-script launches", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 800_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(800));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(SshTunnel.REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          SshTunnel.waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      SshTunnel.describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
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

  it.effect("replaces a stale SSH forward without stopping the remote server", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      let stale = false;
      let forwards = 0;
      let stops = 0;
      let kills = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-N")) {
            forwards += 1;
            stale = false;
            return makeRunningProcess(() => {
              kills += 1;
            });
          }
          if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--"))
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          if (args.includes("sh")) stops += 1;
          return makeSuccessfulProcess("");
        }),
      );
      const httpClient = HttpClient.make((request) =>
        stale
          ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
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
        yield* manager.ensureEnvironment(target);
        stale = true;
        const reconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
        yield* Deferred.await(probeStarted);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(reconnect);
        assert.equal(forwards, 2);
        assert.equal(kills, 1);
        assert.equal(stops, 0);
        yield* manager.disconnectEnvironment(target);
        assert.equal(stops, 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["successful stop", "failed stop"] as const)(
    "closes the tunnel scope and starts fresh after a %s",
    (mode) => {
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
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
            stopCommandCount += 1;
            if (mode === "failed stop" && stopCommandCount === 1) {
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(
                  new TextEncoder().encode("Remote T3 server did not stop within 2 seconds.\n"),
                ),
              };
            }
            return makeSuccessfulProcess('{"stopped":true}\n');
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
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;

      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;

        const first = yield* manager.ensureEnvironment(target);
        assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
        const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
        assert.isDefined(firstTunnelArgs);
        assert.include(firstTunnelArgs, "ControlMaster=no");
        assert.include(firstTunnelArgs, "ControlPath=none");
        assert.include(firstTunnelArgs, "ControlPersist=no");
        assert.deepEqual(firstTunnelArgs?.slice(-2), ["--", "julius@devbox"]);

        const disconnected = yield* Effect.result(manager.disconnectEnvironment(target));
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

        if (mode === "failed stop") {
          yield* manager.disconnectEnvironment(target);
          assert.equal(tunnelKillCount, 1);
          assert.equal(stopCommandCount, 2);
        }

        yield* manager.ensureEnvironment(target);

        assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
        assert.equal(tunnelKillCount, 1);
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.andThen(
          Effect.sync(() => {
            assert.equal(tunnelKillCount, 2);
            assert.equal(stopCommandCount, mode === "failed stop" ? 3 : 2);
          }),
        ),
      );
    },
  );

  it.effect("keeps the stderr reader alive until disconnect", () =>
    Effect.gen(function* () {
      const readerStarted = yield* Deferred.make<void>();
      let readers = 0;
      let finalized = 0;
      const stderr = Stream.fromEffect(
        Effect.sync(() => {
          readers += 1;
        }).pipe(Effect.andThen(Deferred.succeed(readerStarted, undefined))),
      ).pipe(
        Stream.flatMap(() => Stream.fromEffect(Effect.never)),
        Stream.ensuring(
          Effect.sync(() => {
            finalized += 1;
          }),
        ),
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? { ...makeRunningProcess(() => undefined), stderr }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const httpClient = HttpClient.make((request) =>
        Deferred.await(readerStarted).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
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
        yield* manager.ensureEnvironment(target);
        assert.equal(readers, 1);
        assert.equal(finalized, 0, "readiness must not release the stderr reader");
        yield* manager.disconnectEnvironment(target);
        assert.equal(finalized, 1, "disconnect must release the stderr reader");
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

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

  it.live("drains diagnostics beyond pipe capacity after readiness", () =>
    Effect.gen(function* () {
      const nodeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const executable = yield* HostProcess.ExecutablePath;
      const input = yield* Queue.unbounded<Uint8Array>();
      const readerStarted = yield* Deferred.make<void>();
      const tunnelSpawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      let finalized = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!commandArgs(command).includes("-N")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          const child = yield* nodeSpawner.spawn(
            ChildProcess.make(
              executable,
              [
                "-e",
                `process.stdin.once("data", () => {
                process.stderr.write(Buffer.alloc(2 * 1024 * 1024, "x"), () => {
                  process.stdout.write("diagnostics complete\\n");
                });
              });`,
              ],
              { stdin: { stream: Stream.fromQueue(input) } },
            ),
          );
          yield* Deferred.succeed(tunnelSpawned, child);
          return {
            ...child,
            stderr: Stream.fromEffect(Deferred.succeed(readerStarted, undefined)).pipe(
              Stream.flatMap(() => child.stderr),
              Stream.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            ),
          };
        }),
      );
      const httpClient = HttpClient.make((request) =>
        Deferred.await(readerStarted).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
      );
      const layer = Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);
        const child = yield* Deferred.await(tunnelSpawned);
        const progress = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Queue.offer(input, new TextEncoder().encode("write diagnostics"));
        // The deadline only bounds a blocked subprocess; success waits for its write callback.
        assert.deepEqual(yield* Fiber.join(progress).pipe(Effect.timeout("5 seconds")), [
          "diagnostics complete",
        ]);
        assert.isTrue(yield* child.isRunning);
        yield* manager.disconnectEnvironment(target);
        assert.equal(finalized, 1);
        assert.isFalse(yield* child.isRunning);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
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
const MACOS_BIND_PRELOAD = `const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  if (typeof port !== "number" || typeof host !== "string") return listen.apply(this, arguments);
  return listen.call(this, { port, host, reusePort: true }, callback);
};
`;

describe("remote port picker", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const linuxHost = hostPlatform === "linux";
  const windowsHost = hostPlatform === "win32";

  const holdWildcardPort = Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.destroy());
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen({ port: 0, host: "0.0.0.0", reusePort: linuxHost }, () =>
        resume(Effect.succeed(server)),
      );
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

  it.effect.skipIf(windowsHost)("skips a port another server answers on loopback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pick-port-" });
      yield* fs.writeFileString(`${root}/preload.cjs`, MACOS_BIND_PRELOAD);
      yield* fs.writeFileString(`${root}/pick-port.cjs`, SshTunnel.REMOTE_PICK_PORT_SCRIPT);
      const holder = yield* holdWildcardPort;
      const heldPort = (holder.address() as NodeNet.AddressInfo).port;

      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          ...(linuxHost ? ["--require", `${root}/preload.cjs`] : []),
          `${root}/pick-port.cjs`,
          "",
          String(heldPort),
          "20",
        ]),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(exitCode, 0);
      const picked = Number(stdout);
      assert.isAbove(picked, heldPort);
      assert.isBelow(picked, heldPort + 20);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const runScript = (
  home: string,
  args: ReadonlyArray<string>,
  options?: {
    path?: string;
    stdin?: Stream.Stream<Uint8Array>;
    onStderrLine?: (line: string) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("sh", args, {
        env: { PATH: options?.path ?? process.env.PATH ?? "", HOME: home },
        extendEnv: false,
        ...(options?.stdin ? { stdin: { stream: options.stdin } } : {}),
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.tap((line) => options?.onStderrLine?.(line) ?? Effect.void),
          Stream.runFold(
            () => "",
            (acc, line) => `${acc}${line}\n`,
          ),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  });

describe("archive runner script", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const hostArch = HostProcess.Architecture.defaultValue();
  const windowsHost = hostPlatform === "win32";
  const archiveVersion = "1.2.3-preview.20260911.4";

  const runRunner = (home: string, runner: string, options?: Parameters<typeof runScript>[2]) =>
    runScript(home, [runner, "--version"], options);

  const makeMirror = Effect.fn("makeMirror")(function* (root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = hostPlatform === "darwin" ? "darwin" : "linux";
    const arch = hostArch === "arm64" ? "arm64" : "x64";
    const stem = `t3-${archiveVersion}-${platform}-${arch}`;
    const stage = `${root}/stage/${stem}`;
    const release = `${root}/mirror/v${archiveVersion}`;
    const script = [
      "set -eu",
      `mkdir -p '${stage}' '${release}'`,
      `printf '#!/bin/sh\\necho t3 v${archiveVersion}\\n' > '${stage}/t3'`,
      `chmod +x '${stage}/t3'`,
      `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
      `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  it.effect.skipIf(windowsHost)(
    "installs once when several launches race, and reclaims stale locks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-archive-runner-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const runner = `${root}/run-t3.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteT3RunnerScript({ archiveVersion, releaseBaseUrl }),
        );
        const home = `${root}/home`;
        yield* fs.makeDirectory(home, { recursive: true });
        // Reproduce mkdir succeeding on EEXIST, even on hosts without the uutils bug.
        const bin = `${root}/bin`;
        yield* fs.makeDirectory(bin);
        for (const [name, script] of Object.entries({
          mkdir: 'PATH=${PATH#*:}\nexec mkdir -p "$@"',
          tar: 'echo >> "${0%/*}/installs"\necho installing >&2\nread -r release\nPATH=${PATH#*:}\nexec tar "$@"',
          sleep: 'echo waiting >&2\nPATH=${PATH#*:}\nexec sleep "$@"',
        })) {
          yield* fs.writeFileString(`${bin}/${name}`, `#!/bin/sh\n${script}\n`);
          yield* fs.chmod(`${bin}/${name}`, 0o755);
        }
        const path = `${bin}:${process.env.PATH ?? ""}`;
        const installing = yield* Deferred.make<void>();
        const contended = yield* Deferred.make<void>();
        // Hold the first extraction until another runner either waits for the lock
        // or incorrectly begins installing. This forces contention without timing assumptions.
        const first = yield* runRunner(home, runner, {
          path,
          stdin: Stream.fromEffect(
            Deferred.await(contended).pipe(Effect.as(new TextEncoder().encode("release\n"))),
          ),
          onStderrLine: (line) =>
            line === "installing"
              ? Deferred.succeed(installing, undefined).pipe(Effect.asVoid)
              : Effect.void,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(installing);
        const contender = runRunner(home, runner, {
          path,
          stdin: Stream.make(new TextEncoder().encode("release\n")),
          onStderrLine: (line) =>
            line === "installing" || line === "waiting"
              ? Deferred.succeed(contended, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const results = yield* Effect.all([Fiber.join(first), contender, contender], {
          concurrency: "unbounded",
        });
        assert.equal(yield* fs.readFileString(`${bin}/installs`), "\n");
        for (const result of results) {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.include(result.stdout, `t3 v${archiveVersion}`);
        }
        const versionsDir = `${home}/.t3/runtime/versions`;
        assert.deepEqual(yield* fs.readDirectory(versionsDir), [archiveVersion]);
        assert.equal(
          (yield* fs.readFileString(`${versionsDir}/${archiveVersion}/.install-complete`)).trim(),
          archiveVersion,
        );

        const lock = `${versionsDir}/.${archiveVersion}.install.lock`;
        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.writeFileString(lock, "999999\n");
        const afterDead = yield* runRunner(home, runner);
        assert.equal(afterDead.exitCode, 0, afterDead.stderr);

        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.writeFileString(lock, "");
        const afterUnowned = yield* runRunner(home, runner);
        assert.equal(afterUnowned.exitCode, 0, afterUnowned.stderr);
        assert.isFalse(yield* fs.exists(lock));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});

describe("launch script", () => {
  const windowsHost = HostProcess.Platform.defaultValue() === "win32";
  const FAKE_SERVER = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
// --answer-once stalls every request after the first, like a busy server;
// --exit-after-answer exits right after the first answer.
const answerOnce = args.includes("--answer-once");
const exitAfterAnswer = args.includes("--exit-after-answer");
let answered = false;
const server = http.createServer((_request, response) => {
  if (answerOnce && answered) return;
  answered = true;
  response.end("ok", () => {
    if (exitAfterAnswer) process.exit(0);
  });
});
server.listen(Number(flag("--port")), "127.0.0.1", () => {
  const port = server.address().port;
  const userdata = path.join(flag("--base-dir"), "userdata");
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(
    path.join(userdata, "server-runtime.json"),
    JSON.stringify({ version: 1, pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
  );
  console.log(port);
});
`;

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const freeLoopbackPort = Effect.callback<number>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resume(Effect.succeed(typeof address === "object" && address ? address.port : 0)),
      );
    });
  });

  const isListening = (port: number) =>
    Effect.callback<boolean>((resume) => {
      const socket = NodeNet.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resume(Effect.succeed(true));
      });
      socket.once("error", () => resume(Effect.succeed(false)));
    });

  const launchResult = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1) ?? "");

  const prepareLaunch = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-script-" });
    const home = `${root}/home`;
    const stateDir = `${home}/.t3/ssh-launch/test-state`;
    const fakeServer = `${root}/fake-t3.cjs`;
    const launch = `${root}/launch.sh`;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(`${stateDir}/port`, `${yield* freeLoopbackPort}\n`);
    yield* fs.writeFileString(fakeServer, FAKE_SERVER);
    yield* fs.writeFileString(
      launch,
      SshTunnel.buildRemoteLaunchScript({ nodeScriptPath: fakeServer }),
    );
    const readManagedPid = fs
      .readFileString(`${stateDir}/pid`)
      .pipe(Effect.map((pid) => Number(pid.trim())));
    // Launched servers outlive the script, so stop each PID the script
    // recorded, including one it recorded just before a failed assertion.
    const launchedPids: Array<number> = [];
    yield* Effect.addFinalizer(() =>
      readManagedPid.pipe(
        Effect.map((pid) => [...launchedPids, pid]),
        Effect.orElseSucceed(() => launchedPids),
        Effect.map((pids) => {
          for (const pid of pids) {
            if (isAlive(pid)) process.kill(pid, "SIGKILL");
          }
        }),
      ),
    );
    const runLaunchScript = runScript(home, [launch, "test-state"]);
    const runLaunch = runLaunchScript.pipe(
      Effect.map((result) => {
        assert.equal(result.exitCode, 0, result.stderr);
        return launchResult(result.stdout);
      }),
    );
    const launchManaged = Effect.gen(function* () {
      const launched = yield* runLaunch;
      const pid = yield* readManagedPid;
      launchedPids.push(pid);
      assert.equal(launched.serverKind, "managed");
      return { launched, pid };
    });
    const startDefaultHomeServer = (flags: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const args = [fakeServer, "serve", "--port", "0", "--base-dir", `${home}/.t3`, ...flags];
        const server = yield* spawner.spawn(ChildProcess.make("node", args));
        const port = yield* server.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        return { port: Number(Option.getOrThrow(port)), exitCode: server.exitCode };
      });
    return {
      home,
      stateDir,
      launch,
      readManagedPid,
      runLaunchScript,
      runLaunch,
      launchManaged,
      startDefaultHomeServer,
    };
  });

  it.effect.skipIf(windowsHost)(
    "reuses its own managed server and yields only to a different default-home server",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir, readManagedPid, runLaunch, launchManaged, startDefaultHomeServer } =
          yield* prepareLaunch;
        const { launched, pid: managedPid } = yield* launchManaged;

        assert.deepEqual(yield* runLaunch, launched);
        assert.equal(yield* readManagedPid, managedPid);
        assert.isTrue(isAlive(managedPid));

        yield* fs.writeFileString(`${stateDir}/port`, `${yield* freeLoopbackPort}\n`);
        assert.deepEqual(yield* runLaunch, launched);
        assert.equal(yield* readManagedPid, managedPid);
        assert.equal(
          (yield* fs.readFileString(`${stateDir}/port`)).trim(),
          `${launched.remotePort}`,
        );

        const { port: servicePort } = yield* startDefaultHomeServer([]);
        assert.deepEqual(yield* runLaunch, {
          remotePort: servicePort,
          serverKind: "external",
        });
        assert.isFalse(yield* isListening(launched.remotePort));
        assert.isFalse(yield* fs.exists(`${stateDir}/pid`));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect.skipIf(windowsHost)(
    "waits for its busy managed server instead of replacing it",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { readManagedPid, runLaunch, launchManaged } = yield* prepareLaunch;
        const { launched, pid } = yield* launchManaged;

        process.kill(pid, "SIGSTOP");
        yield* spawner.spawn(ChildProcess.make("sh", ["-c", `sleep 5; kill -CONT ${pid}`]));
        assert.deepEqual(yield* runLaunch, launched);
        assert.equal(yield* readManagedPid, pid);
        assert.isTrue(isAlive(pid));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect.skipIf(windowsHost)(
    "fails without stopping a managed server that never becomes ready",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir, launch, readManagedPid, runLaunchScript, launchManaged } =
          yield* prepareLaunch;
        const { launched, pid } = yield* launchManaged;

        const script = yield* fs.readFileString(launch);
        assert.include(script, 'wait_ready "60000"');
        yield* fs.writeFileString(
          launch,
          script.replaceAll('wait_ready "60000"', 'wait_ready "1500"'),
        );
        process.kill(pid, "SIGSTOP");
        const result = yield* runLaunchScript;
        assert.equal(result.exitCode, 1, result.stdout);
        assert.include(result.stderr, "the server was left running");
        assert.isTrue(isAlive(pid));
        assert.equal(yield* readManagedPid, pid);
        assert.equal(
          (yield* fs.readFileString(`${stateDir}/port`)).trim(),
          `${launched.remotePort}`,
        );
        assert.equal((yield* fs.readFileString(`${stateDir}/managed`)).trim(), "managed");
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect.skipIf(windowsHost)(
    "still replaces its managed server when the runner changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir, readManagedPid, runLaunch, launchManaged } = yield* prepareLaunch;
        const { pid: previousPid } = yield* launchManaged;

        yield* fs.writeFileString(`${stateDir}/run-t3.sh`, "# previous runner\n");
        assert.equal((yield* runLaunch).serverKind, "managed");
        const replacementPid = yield* readManagedPid;
        assert.notEqual(replacementPid, previousPid);
        assert.isFalse(isAlive(previousPid));
        assert.isTrue(isAlive(replacementPid));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect.skipIf(windowsHost)(
    "replaces a managed server that exited but was not reaped",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { home, stateDir, readManagedPid, runLaunch, launchManaged } = yield* prepareLaunch;
        const { launched, pid } = yield* launchManaged;
        process.kill(pid, "SIGKILL");

        // A crashed server whose parent never reaps it stays a zombie, which
        // kill -0 still reports. Its pid file and runtime record keep naming it.
        const parent = yield* spawner.spawn(
          ChildProcess.make("sh", ["-c", "sleep 600 & echo $!; exec sleep 600"]),
        );
        const zombie = Number(
          Option.getOrThrow(
            yield* parent.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
          ),
        );
        // Until the parent execs, the shell still reaps its children, and a child killed then
        // never becomes a zombie. Wait for the parent to be the non-reaping sleep.
        const parentExec = yield* runScript(home, [
          "-c",
          `attempt=0; while [ "$attempt" -lt 1000 ]; do
            case "$(ps -o comm= -p ${parent.pid})" in *sleep) exit 0;; esac
            attempt=$((attempt + 1))
          done; exit 1`,
        ]);
        assert.equal(parentExec.exitCode, 0);
        process.kill(zombie, "SIGKILL");
        // SIGKILL delivery is asynchronous; establish the zombie fixture before launching.
        const zombieState = yield* runScript(home, [
          "-c",
          `attempt=0; while [ "$attempt" -lt 100 ]; do
            state=$(ps -o stat= -p ${zombie}) || exit 1
            case "$state" in *Z*) printf '%s\\n' "$state"; exit 0;; esac
            attempt=$((attempt + 1))
          done; printf '%s\\n' "$state"; exit 1`,
        ]);
        assert.equal(zombieState.exitCode, 0, zombieState.stdout);
        assert.include(zombieState.stdout, "Z");
        yield* fs.writeFileString(`${stateDir}/pid`, `${zombie}\n`);
        yield* fs.writeFileString(
          `${home}/.t3/userdata/server-runtime.json`,
          JSON.stringify({
            version: 1,
            pid: zombie,
            port: launched.remotePort,
            origin: `http://127.0.0.1:${launched.remotePort}`,
          }),
        );

        assert.equal((yield* runLaunch).serverKind, "managed");
        const replacementPid = yield* readManagedPid;
        assert.notEqual(replacementPid, zombie);
        assert.isTrue(isAlive(replacementPid));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect.skipIf(windowsHost)(
    "adopts a server it has no managed record for instead of restarting it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir, launchManaged, runLaunch } = yield* prepareLaunch;
        const { launched, pid } = yield* launchManaged;

        yield* fs.remove(`${stateDir}/managed`);
        yield* fs.writeFileString(`${stateDir}/run-t3.sh`, "# superseded runner\n");
        assert.deepEqual(yield* runLaunch, {
          remotePort: launched.remotePort,
          serverKind: "external",
        });
        assert.isTrue(isAlive(pid));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect.skipIf(windowsHost)(
    "keeps an adopted default-home server without launching another beside it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir, runLaunch, startDefaultHomeServer } = yield* prepareLaunch;
        yield* fs.writeFileString(`${stateDir}/managed`, "managed\n");
        const { port: servicePort } = yield* startDefaultHomeServer(["--answer-once"]);

        assert.deepEqual(yield* runLaunch, { remotePort: servicePort, serverKind: "external" });
        assert.isFalse(yield* fs.exists(`${stateDir}/pid`));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect.skipIf(windowsHost)(
    "launches a replacement when the adopted server exits during the handover",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, launch, readManagedPid, launchManaged, startDefaultHomeServer } =
          yield* prepareLaunch;
        const { pid: previousPid } = yield* launchManaged;
        const server = yield* startDefaultHomeServer(["--exit-after-answer"]);
        const adopted = yield* Deferred.make<void>();
        const script = yield* fs.readFileString(launch);
        const adoption = 'ADOPTED_PID="$DEFAULT_RUNTIME_PID"';
        assert.include(script, adoption);
        // A flushed response can arrive before process exit. Hold the launcher at
        // adoption until the fixture has exited, then test its handover check.
        yield* fs.writeFileString(
          launch,
          script.replace(adoption, `${adoption}\n    echo adopted >&2\n    read -r release`),
        );

        const result = yield* runScript(home, [launch, "test-state"], {
          stdin: Stream.fromEffect(
            Deferred.await(adopted).pipe(
              Effect.andThen(server.exitCode.pipe(Effect.orDie)),
              Effect.as(new TextEncoder().encode("release\n")),
            ),
          ),
          onStderrLine: (line) =>
            line === "adopted"
              ? Deferred.succeed(adopted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(launchResult(result.stdout).serverKind, "managed");
        const replacementPid = yield* readManagedPid;
        assert.notEqual(replacementPid, previousPid);
        assert.isTrue(isAlive(replacementPid));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});

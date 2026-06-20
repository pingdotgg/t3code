import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as SshAuth from "./auth.ts";
import {
  SshHttpBridgeInvalidUrlError,
  SshHttpBridgeMissingUrlError,
  SshHttpBridgeNonLoopbackUrlError,
  SshPairingOutputParseError,
  SshReadinessProbeTimeoutError,
  SshReadinessTimeoutError,
} from "./errors.ts";
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
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, 'exec t3 "$@"');
    assert.include(script, "exec npx --yes 't3@latest' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@latest' -- \"$@\"");
    assert.include(script, "could not install 't3@latest'");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
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
  });

  it("does not hard-code a remote node engine range", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(script, "exec npx --yes 't3@nightly; touch /tmp/t3-owned' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@nightly; touch /tmp/t3-owned' -- \"$@\"");
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript({
      nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    assert.include(
      SshTunnel.buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(SshTunnel.buildRemoteLaunchScript(), "RUNNER_CHANGED=1");
    assert.include(SshTunnel.buildRemoteLaunchScript(), "ensure_remote_node_path()");
    assert.include(SshTunnel.buildRemoteLaunchScript(), "if ! ensure_remote_node_path; then");
    assert.include(
      SshTunnel.buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`,
    );
    assert.include(
      SshTunnel.buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "does not satisfy required range ",
    );
    assert.include(SshTunnel.buildRemoteLaunchScript(), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(SshTunnel.buildRemoteLaunchScript(), "wait_ready");
    assert.include(SshTunnel.buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(SshTunnel.buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(SshTunnel.buildRemoteLaunchScript(), "server-home");
    assert.include(SshTunnel.buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(SshTunnel.buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      SshTunnel.buildRemotePairingScript(target),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(
      SshTunnel.buildRemotePairingScript(target),
      'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"',
    );
    assert.notInclude(SshTunnel.buildRemotePairingScript(target), "server-home");
    assert.include(
      SshTunnel.buildRemotePairingScript(target, { packageSpec: "t3@nightly" }),
      "t3@nightly",
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(target),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(target),
      'kill "$REMOTE_PID" 2>/dev/null || true',
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(target),
      'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"',
    );
    assert.include(
      SshTunnel.buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(SshTunnel.buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      SshTunnel.buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(
      SshTunnel.buildRemoteLaunchScript(),
      "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))",
    );
    assert.include(
      SshTunnel.buildRemoteLaunchScript(),
      'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"',
    );
    assert.include(SshTunnel.buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(SshTunnel.buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(SshTunnel.buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(SshTunnel.buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      SshTunnel.buildRemoteLaunchScript().indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      SshTunnel.buildRemoteLaunchScript().indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      SshTunnel.buildRemoteLaunchScript().indexOf(
        'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
      ),
      SshTunnel.buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n')),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(SshTunnel.REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          SshTunnel.waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/?token=base-secret#fragment",
            path: "/ready?credential=request-secret#fragment",
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
        assert.instanceOf(result.failure, SshReadinessTimeoutError);
        const timeoutError = result.failure as SshReadinessTimeoutError;
        assert.deepEqual(timeoutError.base, {
          protocol: "http:",
          hostname: "127.0.0.1",
          port: "41773",
          urlLength: 50,
          pathnameLength: 1,
          hasQuery: true,
          hasFragment: true,
        });
        assert.deepEqual(timeoutError.request, {
          protocol: "http:",
          hostname: "127.0.0.1",
          port: "41773",
          urlLength: 63,
          pathnameLength: 6,
          hasQuery: true,
          hasFragment: true,
        });
        assert.isFalse("baseUrl" in timeoutError);
        assert.isFalse("requestUrl" in timeoutError);
        assert.isFalse("baseTarget" in timeoutError);
        assert.isFalse("requestTarget" in timeoutError);
        assert.notInclude(timeoutError.message, "secret");
        assert.notInclude(timeoutError.message, "/ready");
        assert.notInclude(timeoutError.message, "request-secret");
        assert.equal(
          timeoutError.message,
          "Timed out waiting 1000ms for backend readiness at http://127.0.0.1:41773.",
        );
        assert.isAbove(timeoutError.attempts, 0);
        assert.instanceOf(timeoutError.cause, SshReadinessProbeTimeoutError);
        const probeTimeout = timeoutError.cause as SshReadinessProbeTimeoutError;
        assert.equal(probeTimeout.attempt, timeoutError.attempts);
        assert.isFalse("cause" in probeTimeout);
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it.effect("preserves forwarded HTTP URL error messages", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.result(SshTunnel.resolveLoopbackSshHttpBaseUrl(""));
      assert.isTrue(Result.isFailure(missing));
      if (Result.isFailure(missing)) {
        assert.instanceOf(missing.failure, SshHttpBridgeMissingUrlError);
        assert.equal(missing.failure.message, "Invalid SSH forwarded http base URL.");
      }

      const invalid = yield* Effect.result(SshTunnel.resolveLoopbackSshHttpBaseUrl("not-a-url"));
      assert.isTrue(Result.isFailure(invalid));
      if (Result.isFailure(invalid)) {
        assert.instanceOf(invalid.failure, SshHttpBridgeInvalidUrlError);
        assert.equal(invalid.failure.message, "Invalid SSH forwarded http base URL.");
      }

      const nonLoopback = yield* Effect.result(
        SshTunnel.resolveLoopbackSshHttpBaseUrl("https://example.com"),
      );
      assert.isTrue(Result.isFailure(nonLoopback));
      if (Result.isFailure(nonLoopback)) {
        assert.instanceOf(nonLoopback.failure, SshHttpBridgeNonLoopbackUrlError);
        assert.equal(
          nonLoopback.failure.message,
          "SSH desktop bridge only supports loopback forwarded URLs.",
        );
      }
    }),
  );

  it("describes readiness causes without copying arbitrary messages", () => {
    assert.deepEqual(
      SshTunnel.describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        reason: { type: "string" },
        cause: { type: "string" },
      },
    );
  });

  it("preserves structured readiness attributes in diagnostic output", () => {
    assert.deepEqual(
      SshTunnel.describeReadinessCause(
        new SshReadinessProbeTimeoutError({
          request: {
            protocol: "http:",
            hostname: "127.0.0.1",
            port: "41773",
            urlLength: 28,
            pathnameLength: 6,
            hasQuery: false,
            hasFragment: false,
          },
          timeoutMs: 250,
          attempt: 3,
        }),
      ),
      {
        _tag: "SshReadinessProbeTimeoutError",
        request: {
          protocol: "http:",
          hostname: "127.0.0.1",
          port: "41773",
          urlLength: 28,
          pathnameLength: 6,
          hasQuery: false,
          hasFragment: false,
        },
        timeoutMs: 250,
        attempt: 3,
        message: "Backend readiness probe exceeded 250ms at http://127.0.0.1:41773.",
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
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
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
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("does not copy pairing command output into parse errors", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const output = '{"credential":"pairing-secret"';
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeSuccessfulProcess(output)));
    const processLayer = Layer.merge(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const result = yield* Effect.result(SshTunnel.issueRemotePairingToken(target));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshPairingOutputParseError);
        assert.equal(result.failure.stdoutBytes, new TextEncoder().encode(output).length);
        assert.isFalse("stdout" in result.failure);
        assert.notInclude(result.failure.message, "pairing-secret");
        assert.exists(result.failure.cause);
      }
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("retries authentication when a spawn error wraps an SSH auth failure", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const authFailure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
      pathOrDescriptor: "ssh",
      description: "Permission denied (publickey,password).",
    });
    const promptAttempts: number[] = [];
    let launchAttempts = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      const args = commandArgs(command);
      if (args.includes("sh") && args.includes("--")) {
        launchAttempts += 1;
        if (launchAttempts === 1) {
          return Effect.fail(authFailure);
        }
        return Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n'));
      }
      if (args.includes("-N")) {
        return Effect.succeed(makeRunningProcess(() => {}));
      }
      return Effect.succeed(makeSuccessfulProcess("\n"));
    });
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.layer({
        isAvailable: true,
        request: (request) =>
          Effect.sync(() => {
            promptAttempts.push(request.attempt);
            return "secret";
          }),
      }),
      SshTunnel.layer(),
    );

    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const environment = yield* manager.ensureEnvironment(target);

      assert.equal(environment.remotePort, 3773);
      assert.equal(launchAttempts, 2);
      assert.deepEqual(promptAttempts, [1]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("closes the tunnel scope and starts fresh after disconnect", () => {
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
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopCommandCount += 1;
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
      SshAuth.disabledLayer,
      SshTunnel.layer(),
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

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});

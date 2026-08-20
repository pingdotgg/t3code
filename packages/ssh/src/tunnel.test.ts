import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import { SshReadinessError } from "./errors.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_PICK_PORT_SCRIPT,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

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

const makeRunningProcess = (
  onKill: () => void,
  stderr:
    | string
    | Stream.Stream<Uint8Array> = "debug1: Local forwarding listening on 127.0.0.1 port 41773.\n",
  isRunning: Effect.Effect<boolean> = Effect.succeed(true),
) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: typeof stderr === "string" ? Stream.make(new TextEncoder().encode(stderr)) : stderr,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning,
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
  hasListenerOnHost: () => Effect.succeed(true),
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
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

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
    const script = buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(script, "exec npx --yes 't3@nightly; touch /tmp/t3-owned' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@nightly; touch /tmp/t3-owned' -- \"$@\"");
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = buildRemoteT3RunnerScript({
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
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(buildRemoteLaunchScript(), "RUNNER_CHANGED=1");
    assert.include(buildRemoteLaunchScript(), "ensure_remote_node_path()");
    assert.include(buildRemoteLaunchScript(), "if ! ensure_remote_node_path; then");
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`,
    );
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "does not satisfy required range ",
    );
    assert.include(buildRemoteLaunchScript(), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteLaunchScript(), "wait_ready");
    assert.include(buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemoteLaunchScript(), "server-home");
    assert.include(buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemotePairingScript(target),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(buildRemotePairingScript(target), 'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemotePairingScript(target), "server-home");
    assert.include(buildRemotePairingScript(target, { packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemoteStopScript(target),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
    );
    assert.include(buildRemoteStopScript(target), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteStopScript(target), 'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"');
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(
      buildRemoteLaunchScript(),
      "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))",
    );
    assert.include(buildRemoteLaunchScript(), 'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"');
    assert.include(buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      buildRemoteLaunchScript().indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PID" ]'),
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
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
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
      describeReadinessCause({
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
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
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
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
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
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      const tunnelCommands = spawnedCommands.filter((args) => args.includes("-N"));
      assert.equal(tunnelCommands.length, 2);
      assert.include(tunnelCommands[0] ?? [], "127.0.0.1:41773:127.0.0.1:3773");
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("reference-counts shared preview port forwards", () => {
    let tunnelSpawnCount = 0;
    let tunnelKillCount = 0;
    const forwardArgs: ReadonlyArray<string>[] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-N")) {
          tunnelSpawnCount += 1;
          forwardArgs.push(args);
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const [first, second] = yield* Effect.all(
        [manager.acquirePortForward(target, 5173), manager.acquirePortForward(target, 5173)],
        { concurrency: "unbounded" },
      );

      assert.equal(first.localPort, second.localPort);
      assert.notEqual(first.leaseId, second.leaseId);
      assert.equal(tunnelSpawnCount, 1);
      assert.include(forwardArgs[0] ?? [], "127.0.0.1:41773:localhost:5173");
      assert.include(forwardArgs[0] ?? [], "-v");

      yield* manager.releasePortForward(first.leaseId);
      assert.equal(tunnelKillCount, 0);

      yield* manager.releasePortForward(second.leaseId);
      assert.equal(tunnelKillCount, 1);

      const third = yield* manager.acquirePortForward(target, 5173);
      assert.equal(tunnelSpawnCount, 2);

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 2);

      yield* manager.releasePortForward(third.leaseId);
      assert.equal(tunnelKillCount, 2);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("serializes reuse against release of the last lease", () => {
    let tunnelKillCount = 0;
    let runningCheck: Effect.Effect<boolean> = Effect.succeed(true);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-N")) {
          return makeRunningProcess(
            () => {
              tunnelKillCount += 1;
            },
            undefined,
            Effect.suspend(() => runningCheck),
          );
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const first = yield* manager.acquirePortForward(target, 5173);
      const runningCheckStarted = yield* Deferred.make<void>();
      const finishRunningCheck = yield* Deferred.make<boolean>();
      runningCheck = Deferred.succeed(runningCheckStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishRunningCheck)),
      );

      const secondFiber = yield* Effect.forkChild(manager.acquirePortForward(target, 5173));
      yield* Deferred.await(runningCheckStarted);
      const releaseFiber = yield* Effect.forkChild(manager.releasePortForward(first.leaseId));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(finishRunningCheck, true);

      const second = yield* Fiber.join(secondFiber);
      yield* Fiber.join(releaseFiber);
      assert.equal(tunnelKillCount, 0);

      yield* manager.releasePortForward(second.leaseId);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("cancels a pending port forward when the manager scope closes", () => {
    let tunnelKillCount = 0;
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const readinessStarted = yield* Deferred.make<void>();
      const readyStderr = Stream.fromEffect(
        Deferred.succeed(readinessStarted, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-N")) {
            return makeRunningProcess(() => {
              tunnelKillCount += 1;
            }, readyStderr);
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer(),
      );
      const managerScope = yield* Scope.make("sequential");
      const context = yield* Layer.buildWithScope(layer, managerScope);
      const manager = Context.get(context, SshEnvironmentManager);
      const acquisitionFiber = yield* Effect.forkChild(
        Effect.result(manager.acquirePortForward(target, 5173)).pipe(Effect.provide(context)),
      );
      yield* Deferred.await(readinessStarted);

      const closeFiber = yield* Effect.forkChild(Scope.close(managerScope, Exit.void));

      const acquisitionResult = yield* Fiber.join(acquisitionFiber);
      yield* Fiber.join(closeFiber);
      assert(Result.isFailure(acquisitionResult));
      assert.equal(tunnelKillCount, 1);
    });
  });

  it.effect("does not accept an unrelated local listener as SSH forward readiness", () => {
    let tunnelKillCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          }, "bind [127.0.0.1]:41773: Address already in use\n");
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const error = yield* manager.acquirePortForward(target, 5173).pipe(Effect.flip);

      assert.instanceOf(error, SshReadinessError);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});

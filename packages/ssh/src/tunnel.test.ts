import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import { SshCommandError } from "./errors.ts";
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
import { collectProcessOutput, remoteStateKey } from "./command.ts";

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

const makeFailedProcess = (stderr: string) => {
  const stderrStream = Stream.make(new TextEncoder().encode(stderr));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: stderrStream,
    all: stderrStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
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

function commandEnvironment(
  command: ChildProcess.Command,
): Readonly<Record<string, string | undefined>> | undefined {
  return command._tag === "StandardCommand" ? command.options.env : undefined;
}

function isManagedLaunchCommand(args: ReadonlyArray<string>): boolean {
  return args.includes("sh") && args.filter((arg) => arg === "--").length === 2;
}

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, 'exec t3 "$@"');
    assert.notInclude(script, "exec npx --yes 't3@latest' \"$@\"");
    assert.notInclude(script, "exec npm exec --yes 't3@latest' -- \"$@\"");
    assert.include(script, 'exec "$T3_CLI_PATH" "$@"');
    assert.include(script, "could not install 't3@latest'");
    assert.include(script, "require_installed_t3_cli npx --yes --package 't3@latest'");
    assert.include(script, "require_installed_t3_cli npm exec --yes --package 't3@latest'");
    assert.include(script, "npm produced no t3 executable");
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

    assert.notInclude(script, "exec npx --yes 't3@nightly; touch /tmp/t3-owned' \"$@\"");
    assert.notInclude(script, "exec npm exec --yes 't3@nightly; touch /tmp/t3-owned' -- \"$@\"");
    assert.include(
      script,
      "require_installed_t3_cli npx --yes --package 't3@nightly; touch /tmp/t3-owned'",
    );
    assert.include(script, 'exec "$T3_CLI_PATH" "$@"');
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
      "managed_pid_is_owned()",
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
    assert.include(buildRemoteLaunchScript(), "wait_ready");
    assert.include(
      buildRemoteLaunchScript(),
      '"$MANAGED_WRAPPER_FILE" "$RUNNER_FILE" "$REMOTE_NONCE" "$WRAPPER_READY_FILE" serve --host 127.0.0.1',
    );
    assert.include(buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemoteLaunchScript(), "server-home");
    assert.include(buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(buildRemoteLaunchScript(), 'wait_ready "60000"');
    assert.include(buildRemoteLaunchScript(), 'if [ -s "$LOG_FILE" ]; then');
    assert.include(buildRemoteLaunchScript(), "It wrote nothing to %s");
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
      'if [ "$REMOTE_MANAGED" = "managed" ] && [ -n "$EXPECTED_PID_START" ]',
    );
    assert.include(buildRemoteStopScript(target), 'if ! kill "$REMOTE_PID" 2>/dev/null');
    assert.include(buildRemoteStopScript(target), 'PS_IDENTITY="$(LC_ALL=C ps -o lstart=');
    assert.include(
      buildRemoteStopScript(target),
      'rm -f "$PID_FILE" "$PID_START_FILE" "$PORT_FILE" "$MANAGED_FILE"',
    );
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(buildRemoteLaunchScript(), "port > 65535");
    assert.include(buildRemoteLaunchScript(), 'PID_START_FILE="$STATE_DIR/pid-start"');
    assert.include(buildRemoteLaunchScript(), 'MANAGED_WRAPPER_FILE="$STATE_DIR/run-managed.sh"');
    assert.include(buildRemoteLaunchScript(), 'randomBytes(24).toString("hex")');
    assert.include(
      buildRemoteLaunchScript(),
      'proc:*|ps:*"$MANAGED_WRAPPER_FILE"*"$REMOTE_NONCE"*',
    );
    assert.include(buildRemoteLaunchScript(), "printf 'ready\\n' >\"$WRAPPER_READY_FILE\"");
    assert.include(buildRemoteLaunchScript(), '[ "$DEFAULT_RUNTIME_PID" = "$REMOTE_PID" ]');
    assert.include(buildRemoteLaunchScript(), 'Number(origin.port || "80") !== port');
    assert.include(
      buildRemoteLaunchScript(),
      'if [ "$REMOTE_MANAGED" = "managed" ] && ! stop_managed_pid; then',
    );
    assert.include(buildRemoteLaunchScript(), 'path: "/.well-known/t3/environment"');
    assert.notInclude(
      buildRemoteLaunchScript(),
      'else\n    kill "$REMOTE_PID" 2>/dev/null || true',
    );
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
      buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PORT" ]; then'),
    );
  });

  it.effect("generates valid POSIX remote lifecycle scripts", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") {
        return;
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;
      for (const script of [buildRemoteLaunchScript(), buildRemoteStopScript(target)]) {
        const child = yield* spawner.spawn(ChildProcess.make("sh", ["-n", "-c", script]));
        assert.equal(Number(yield* child.exitCode), 0);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps remote state when the managed process survives stop", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") {
        return;
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-stop-test-" });
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;
      const stateDir = path.join(homeDir, ".t3", "ssh-launch", remoteStateKey(target));
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "pid"), "123\n");
      yield* fs.writeFileString(path.join(stateDir, "pid-start"), "ps:start\n");
      yield* fs.writeFileString(path.join(stateDir, "port"), "3773\n");
      yield* fs.writeFileString(path.join(stateDir, "managed"), "managed\n");
      const script = `kill() { return 0; }\nps() { printf 'start\\n'; }\nsleep() { return 0; }\n${buildRemoteStopScript(target)}`;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", script], {
          env: { HOME: homeDir },
          extendEnv: true,
        }),
      );
      const [stderr, exitCode] = yield* Effect.all([
        collectProcessOutput(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ]);

      assert.equal(exitCode, 1);
      assert.include(stderr, "did not stop");
      assert.isTrue(yield* fs.exists(path.join(stateDir, "pid")));
      assert.isTrue(yield* fs.exists(path.join(stateDir, "port")));
      assert.isTrue(yield* fs.exists(path.join(stateDir, "managed")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("clears managed state after the verified process stops", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") {
        return;
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-stop-success-test-" });
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;
      const stateDir = path.join(homeDir, ".t3", "ssh-launch", remoteStateKey(target));
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "pid"), "123\n");
      yield* fs.writeFileString(path.join(stateDir, "pid-start"), "ps:start\n");
      yield* fs.writeFileString(path.join(stateDir, "port"), "3773\n");
      yield* fs.writeFileString(path.join(stateDir, "managed"), "managed\n");
      const script = `kill() { if [ "$1" = "-0" ]; then [ -f "$HOME/alive" ]; else rm -f "$HOME/alive"; touch "$HOME/signalled"; fi; }\nps() { [ -f "$HOME/alive" ] && printf 'start\\n'; }\ntouch "$HOME/alive"\n${buildRemoteStopScript(target)}`;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", script], {
          env: { HOME: homeDir },
          extendEnv: true,
        }),
      );
      const exitCode = yield* child.exitCode.pipe(Effect.map(Number));

      assert.equal(exitCode, 0);
      assert.isTrue(yield* fs.exists(path.join(homeDir, "signalled")));
      assert.isFalse(yield* fs.exists(path.join(stateDir, "pid")));
      assert.isFalse(yield* fs.exists(path.join(stateDir, "pid-start")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not signal a process that reused a stale managed PID", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") {
        return;
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-stale-pid-test-" });
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;
      const stateDir = path.join(homeDir, ".t3", "ssh-launch", remoteStateKey(target));
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "pid"), "123\n");
      yield* fs.writeFileString(path.join(stateDir, "pid-start"), "ps:old-start\n");
      yield* fs.writeFileString(path.join(stateDir, "port"), "3773\n");
      yield* fs.writeFileString(path.join(stateDir, "managed"), "managed\n");
      const script = `kill() { if [ "$1" != "-0" ]; then touch "$HOME/signalled"; fi; return 0; }\nps() { printf 'new-start\\n'; }\n${buildRemoteStopScript(target)}`;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", script], {
          env: { HOME: homeDir },
          extendEnv: true,
        }),
      );
      const exitCode = yield* child.exitCode.pipe(Effect.map(Number));

      assert.equal(exitCode, 0);
      assert.isFalse(yield* fs.exists(path.join(homeDir, "signalled")));
      assert.isFalse(yield* fs.exists(path.join(stateDir, "pid")));
      assert.isFalse(yield* fs.exists(path.join(stateDir, "pid-start")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("retains managed state when process identity cannot be verified", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") {
        return;
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-pid-probe-test-" });
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;
      const stateDir = path.join(homeDir, ".t3", "ssh-launch", remoteStateKey(target));
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "pid"), "123\n");
      yield* fs.writeFileString(path.join(stateDir, "pid-start"), "ps:start\n");
      yield* fs.writeFileString(path.join(stateDir, "port"), "3773\n");
      yield* fs.writeFileString(path.join(stateDir, "managed"), "managed\n");
      const script = `kill() { if [ "$1" != "-0" ]; then touch "$HOME/signalled"; fi; return 0; }\nps() { return 1; }\n${buildRemoteStopScript(target)}`;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", script], {
          env: { HOME: homeDir, PATH: "/usr/bin:/bin" },
          extendEnv: true,
        }),
      );
      const exitCode = yield* child.exitCode.pipe(Effect.map(Number));

      assert.equal(exitCode, 1);
      assert.isFalse(yield* fs.exists(path.join(homeDir, "signalled")));
      assert.isTrue(yield* fs.exists(path.join(stateDir, "pid")));
      assert.isTrue(yield* fs.exists(path.join(stateDir, "pid-start")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("retains live managed state when its identity file is missing", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") {
        return;
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-partial-state-test-" });
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;
      const stateDir = path.join(homeDir, ".t3", "ssh-launch", remoteStateKey(target));
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "pid"), "123\n");
      yield* fs.writeFileString(path.join(stateDir, "port"), "3773\n");
      yield* fs.writeFileString(path.join(stateDir, "managed"), "managed\n");
      const script = `kill() { if [ "$1" != "-0" ]; then touch "$HOME/signalled"; fi; return 0; }\nps() { printf 'start\\n'; }\n${buildRemoteStopScript(target)}`;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", script], {
          env: { HOME: homeDir },
          extendEnv: true,
        }),
      );
      const exitCode = yield* child.exitCode.pipe(Effect.map(Number));

      assert.equal(exitCode, 1);
      assert.isFalse(yield* fs.exists(path.join(homeDir, "signalled")));
      assert.isTrue(yield* fs.exists(path.join(stateDir, "pid")));
      assert.isTrue(yield* fs.exists(path.join(stateDir, "managed")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

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
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("redacts forwarded values from malformed successful launch output", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
      environmentVariables: { TOKEN: "forwarded-secret" },
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess("startup forwarded-secret without launch JSON\n")),
    );
    const processLayer = Layer.merge(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const result = yield* Effect.result(launchOrReuseRemoteServer(target));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure._tag, "SshLaunchError");
        if (result.failure._tag === "SshLaunchError") {
          assert.notInclude(result.failure.stdout, "forwarded-secret");
          assert.include(result.failure.stdout, "[redacted]");
        }
      }
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("rejects out-of-range remote launch ports", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess('{"remotePort":65536}\n')),
    );
    const processLayer = Layer.merge(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const result = yield* Effect.result(launchOrReuseRemoteServer(target));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure._tag, "SshLaunchError");
      }
    }).pipe(Effect.provide(processLayer));
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
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(launchOrReuseRemoteServer(target));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("ignores an out-of-range preferred port from remote state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const nodePath = yield* HostProcessExecutablePath;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-port-test-" });
      const portFile = path.join(directory, "port");
      yield* fs.writeFileString(portFile, "70000\n");
      const child = yield* spawner.spawn(
        ChildProcess.make(nodePath, [
          "-e",
          REMOTE_PICK_PORT_SCRIPT,
          "unused",
          portFile,
          "49152",
          "100",
        ]),
      );
      const [stdout, exitCode] = yield* Effect.all([
        collectProcessOutput(child.stdout),
        child.exitCode.pipe(Effect.map(Number)),
      ]);
      const selectedPort = Number(stdout);

      assert.equal(exitCode, 0);
      assert.isAtLeast(selectedPort, 49_152);
      assert.isAtMost(selectedPort, 49_251);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

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

  it.effect("redacts credentials from malformed successful pairing output", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess('{"credential":"pairing-secret"\n')),
    );
    const processLayer = Layer.merge(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const result = yield* Effect.result(issueRemotePairingToken(target));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure._tag, "SshPairingError");
        if (result.failure._tag === "SshPairingError") {
          assert.notInclude(result.failure.stdout, "pairing-secret");
          assert.equal(result.failure.stdout, "");
        }
      }
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
        if (isManagedLaunchCommand(args)) {
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
      const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
      assert.isDefined(firstTunnelArgs);
      assert.include(firstTunnelArgs, "ControlMaster=no");
      assert.include(firstTunnelArgs, "ControlPath=none");
      assert.include(firstTunnelArgs, "ControlPersist=no");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("disconnects a live tunnel without revalidating its saved SendEnv", () => {
    let resolveCount = 0;
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          resolveCount += 1;
          return makeSuccessfulProcess("sendenv TOKEN\n");
        }
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (isManagedLaunchCommand(args)) {
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
      environmentVariables: { TOKEN: "forwarded-value" },
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      yield* manager.ensureEnvironment(target);

      assert.equal(resolveCount, 3);
      yield* manager.disconnectEnvironment(target);

      assert.equal(resolveCount, 3);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("disconnects a saved target without a tracked tunnel or SendEnv validation", () => {
    let resolveCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          resolveCount += 1;
          return makeFailedProcess("SSH config is unavailable\n");
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
    const savedTarget = {
      alias: "devbox",
      hostname: "resolved.example.com",
      username: "resolved-user",
      port: 2200,
      environmentVariables: { TOKEN: "forwarded-value" },
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      yield* manager.disconnectEnvironment(savedTarget);

      assert.equal(resolveCount, 0);
      assert.equal(stopCommandCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("stops the resolved target after tunnel creation fails", () => {
    const postLaunchCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          return makeSuccessfulProcess(
            [
              "hostname resolved.example.com",
              "user resolved-user",
              "port 2200",
              "sendenv TOKEN",
              "",
            ].join("\n"),
          );
        }
        if (args.includes("-N")) {
          return makeFailedProcess("tunnel failed for forwarded-secret\n");
        }
        if (isManagedLaunchCommand(args)) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          postLaunchCommands.push(args);
          return makeSuccessfulProcess('{"stopped":true}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox",
      username: null,
      port: null,
      environmentVariables: { TOKEN: "forwarded-secret" },
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const ensureResult = yield* Effect.result(manager.ensureEnvironment(target));
      assert.isTrue(Result.isFailure(ensureResult));
      if (Result.isFailure(ensureResult)) {
        assert.instanceOf(ensureResult.failure, SshCommandError);
        assert.equal(ensureResult.failure.stderr, "tunnel failed for [redacted]\n");
      }
      assert.equal(postLaunchCommands.length, 2);
      const failedLaunchStopArgs = postLaunchCommands[1] ?? [];
      assert.include(failedLaunchStopArgs, "2200");
      assert.include(failedLaunchStopArgs, "resolved-user@devbox");

      yield* manager.disconnectEnvironment(target);

      assert.equal(postLaunchCommands.length, 3);
      const disconnectStopArgs = postLaunchCommands[2] ?? [];
      assert.include(disconnectStopArgs, "2200");
      assert.include(disconnectStopArgs, "resolved-user@devbox");
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("replaces a live tunnel when its local SSH environment changes", () => {
    const tunnelEnvironments: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const remoteLifecycle: Array<"launch" | "stop"> = [];
    let tunnelKillCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          return makeSuccessfulProcess("sendenv TOKEN\n");
        }
        if (args.includes("-N")) {
          tunnelEnvironments.push(commandEnvironment(command));
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (isManagedLaunchCommand(args)) {
          remoteLifecycle.push("launch");
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          remoteLifecycle.push("stop");
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
      yield* manager.ensureEnvironment({
        ...target,
        environmentVariables: { TOKEN: "old-value" },
      });
      yield* manager.ensureEnvironment({
        ...target,
        environmentVariables: { TOKEN: "new-value" },
      });

      assert.equal(tunnelEnvironments.length, 2);
      assert.equal(tunnelEnvironments[0]?.TOKEN, "old-value");
      assert.equal(tunnelEnvironments[1]?.TOKEN, "new-value");
      assert.equal(tunnelKillCount, 1);
      assert.deepEqual(remoteLifecycle, ["launch", "stop", "launch"]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("closes the old tunnel and retries its failed remote stop before replacement", () => {
    let launchCount = 0;
    let stopAttemptCount = 0;
    let tunnelKillCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          return makeSuccessfulProcess("sendenv TOKEN\n");
        }
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (isManagedLaunchCommand(args)) {
          launchCount += 1;
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopAttemptCount += 1;
          return stopAttemptCount <= 2
            ? makeFailedProcess("stop failed\n")
            : makeSuccessfulProcess('{"stopped":true}\n');
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
      yield* manager.ensureEnvironment({
        ...target,
        environmentVariables: { TOKEN: "old-value" },
      });
      const replaceExit = yield* Effect.exit(
        manager.ensureEnvironment({
          ...target,
          environmentVariables: { TOKEN: "new-value" },
        }),
      );

      assert.isTrue(Exit.isFailure(replaceExit));
      assert.equal(launchCount, 1);
      assert.equal(stopAttemptCount, 2);
      assert.equal(tunnelKillCount, 1);

      yield* manager.ensureEnvironment({
        ...target,
        environmentVariables: { TOKEN: "new-value" },
      });
      assert.equal(stopAttemptCount, 3);
      assert.equal(launchCount, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("serializes resolution and replacement for the same requested target", () =>
    Effect.gen(function* () {
      const pairingStarted = yield* Deferred.make<void>();
      const releasePairing = yield* Deferred.make<void>();
      const tunnelEnvironments: Array<Readonly<Record<string, string | undefined>> | undefined> =
        [];
      let tunnelKillCount = 0;
      let shellCommandCount = 0;
      let resolveCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          const environment = commandEnvironment(command);
          if (args.includes("-G")) {
            resolveCount += 1;
            if (resolveCount % 3 === 0) {
              assert.isDefined(environment?.TOKEN);
            } else {
              assert.isUndefined(environment?.TOKEN);
            }
            const resolvedHost = resolveCount <= 3 ? "first.example.com" : "second.example.com";
            return makeSuccessfulProcess(`hostname ${resolvedHost}\nsendenv TOKEN\n`);
          }
          if (args.includes("-N")) {
            tunnelEnvironments.push(environment);
            return makeRunningProcess(() => {
              tunnelKillCount += 1;
            });
          }
          if (isManagedLaunchCommand(args)) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
            shellCommandCount += 1;
            if (shellCommandCount === 1) {
              yield* Deferred.succeed(pairingStarted, undefined).pipe(Effect.ignore);
              const process = makeSuccessfulProcess('{"credential":"PAIRING-CODE"}\n');
              return {
                ...process,
                exitCode: Deferred.await(releasePairing).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
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
        SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer(),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;

      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const firstFiber = yield* Effect.forkChild(
          manager.ensureEnvironment(
            { ...target, environmentVariables: { TOKEN: "old-value" } },
            { issuePairingToken: true },
          ),
        );
        yield* Deferred.await(pairingStarted);

        const secondFiber = yield* Effect.forkChild(
          manager.ensureEnvironment({
            ...target,
            environmentVariables: { TOKEN: "new-value" },
          }),
        );
        yield* Effect.yieldNow;

        assert.equal(resolveCount, 3);
        assert.equal(tunnelKillCount, 0);
        yield* Deferred.succeed(releasePairing, undefined);

        const first = yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);
        assert.equal(first.pairingToken, "PAIRING-CODE");
        assert.equal(resolveCount, 6);
        assert.equal(tunnelKillCount, 1);
        assert.equal(tunnelEnvironments.length, 2);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("replaces the existing profile tunnel when SSH config resolves differently", () => {
    let resolveCount = 0;
    let tunnelKillCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          resolveCount += 1;
          return makeSuccessfulProcess(
            [`hostname devbox-${resolveCount}.example.com`, "user julius", "port 2222", ""].join(
              "\n",
            ),
          );
        }
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (isManagedLaunchCommand(args)) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
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
    const requestedTarget = {
      alias: "devbox",
      hostname: "devbox",
      username: null,
      port: null,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const first = yield* manager.ensureEnvironment(requestedTarget);
      const second = yield* manager.ensureEnvironment(first.target);

      assert.equal(first.target.hostname, "devbox-1.example.com");
      assert.equal(second.target.hostname, "devbox-2.example.com");
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("keeps a failed old-host stop pending after SSH config drift", () => {
    let resolveCount = 0;
    let launchCount = 0;
    let oldHostStopCount = 0;
    let newHostStopCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          resolveCount += 1;
          const oldHost = resolveCount === 1;
          return makeSuccessfulProcess(
            [
              `hostname ${oldHost ? "old" : "new"}.example.com`,
              `user ${oldHost ? "old-user" : "new-user"}`,
              "port 2222",
              "",
            ].join("\n"),
          );
        }
        if (args.includes("-N")) {
          return makeRunningProcess(() => {});
        }
        if (isManagedLaunchCommand(args)) {
          launchCount += 1;
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          if (args.includes("old-user@devbox")) {
            oldHostStopCount += 1;
            return oldHostStopCount <= 3
              ? makeFailedProcess("old host stop failed\n")
              : makeSuccessfulProcess('{"stopped":true}\n');
          }
          newHostStopCount += 1;
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
    const requestedTarget = {
      alias: "devbox",
      hostname: "devbox",
      username: null,
      port: null,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      yield* manager.ensureEnvironment(requestedTarget);
      const replacementExit = yield* Effect.exit(manager.ensureEnvironment(requestedTarget));
      const disconnectExit = yield* Effect.exit(manager.disconnectEnvironment(requestedTarget));

      assert.isTrue(Exit.isFailure(replacementExit));
      assert.isTrue(Exit.isFailure(disconnectExit));
      assert.equal(oldHostStopCount, 3);
      assert.equal(newHostStopCount, 0);

      yield* manager.ensureEnvironment(requestedTarget);
      assert.equal(oldHostStopCount, 4);
      assert.equal(launchCount, 2);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("prefers an existing resolved tunnel over a stale requested mapping", () => {
    let resolveCount = 0;
    let tunnelCount = 0;
    let tunnelKillCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          resolveCount += 1;
          const hostname = resolveCount === 1 ? "old.example.com" : "new.example.com";
          return makeSuccessfulProcess(
            [`hostname ${hostname}`, "user julius", "port 2222", ""].join("\n"),
          );
        }
        if (args.includes("-N")) {
          tunnelCount += 1;
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (isManagedLaunchCommand(args)) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
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
    const initialTarget = {
      alias: "devbox",
      hostname: "devbox",
      username: null,
      port: null,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const oldEnvironment = yield* manager.ensureEnvironment(initialTarget);
      yield* manager.ensureEnvironment({
        alias: "devbox",
        hostname: "new.example.com",
        username: "julius",
        port: 2222,
      });
      yield* manager.ensureEnvironment(oldEnvironment.target);

      assert.equal(tunnelCount, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("does not stop the selected target for a stale conflicting key", () =>
    Effect.gen(function* () {
      const stopStarted = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      const conflictingResolveStarted = yield* Deferred.make<void>();
      let resolveCount = 0;
      let stopCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-G")) {
            resolveCount += 1;
            const hostname = resolveCount === 1 ? "old.example.com" : "new.example.com";
            if (resolveCount === 3) {
              yield* Deferred.succeed(conflictingResolveStarted, undefined).pipe(Effect.ignore);
            }
            return makeSuccessfulProcess(
              [`hostname ${hostname}`, "user julius", "port 2222", ""].join("\n"),
            );
          }
          if (args.includes("-N")) {
            return makeRunningProcess(() => undefined);
          }
          if (isManagedLaunchCommand(args)) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
            stopCount += 1;
            yield* Deferred.succeed(stopStarted, undefined).pipe(Effect.ignore);
            const process = makeSuccessfulProcess('{"stopped":true}\n');
            return {
              ...process,
              exitCode: Deferred.await(releaseStop).pipe(
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
        SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer(),
      );
      const requestedTarget = {
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      } as const;

      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const oldEnvironment = yield* manager.ensureEnvironment(requestedTarget);
        yield* manager.ensureEnvironment({
          alias: "devbox",
          hostname: "new.example.com",
          username: "julius",
          port: 2222,
        });

        const disconnectFiber = yield* Effect.forkChild(
          manager.disconnectEnvironment(requestedTarget),
        );
        yield* Deferred.await(stopStarted);
        const ensureFiber = yield* Effect.forkChild(
          manager.ensureEnvironment(oldEnvironment.target),
        );
        yield* Deferred.await(conflictingResolveStarted);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseStop, undefined);

        yield* Fiber.join(disconnectFiber);
        yield* Fiber.join(ensureFiber);
        assert.equal(stopCount, 1);
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseStop, undefined).pipe(Effect.ignore)),
        Effect.provide(layer),
        Effect.scoped,
      );
    }),
  );

  it.effect("does not block unrelated hosts behind an in-flight ensure", () =>
    Effect.gen(function* () {
      const pairingStarted = yield* Deferred.make<void>();
      const releasePairing = yield* Deferred.make<void>();
      const tunnelAliases: Array<string> = [];
      let shellCommandCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-G")) {
            return makeSuccessfulProcess("\n");
          }
          if (args.includes("-N")) {
            tunnelAliases.push(args.at(-1) ?? "");
            return makeRunningProcess(() => undefined);
          }
          if (isManagedLaunchCommand(args)) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
            shellCommandCount += 1;
            if (shellCommandCount === 1) {
              yield* Deferred.succeed(pairingStarted, undefined).pipe(Effect.ignore);
              const process = makeSuccessfulProcess('{"credential":"PAIRING-CODE"}\n');
              return {
                ...process,
                exitCode: Deferred.await(releasePairing).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }
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

      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const firstFiber = yield* Effect.forkChild(
          manager.ensureEnvironment(
            {
              alias: "first-host",
              hostname: "first.example.com",
              username: "julius",
              port: 2222,
            },
            { issuePairingToken: true },
          ),
        );
        yield* Deferred.await(pairingStarted);
        const queuedSameTarget = yield* Effect.forEach(Array.from({ length: 3 }), () =>
          Effect.forkChild(
            manager.ensureEnvironment({
              alias: "first-host",
              hostname: "first.example.com",
              username: "julius",
              port: 2222,
            }),
          ),
        );
        yield* Effect.yieldNow;

        const second = yield* manager.ensureEnvironment({
          alias: "second-host",
          hostname: "second.example.com",
          username: "julius",
          port: 2222,
        });
        assert.equal(second.target.alias, "second-host");
        assert.isTrue(tunnelAliases.some((alias) => alias.endsWith("@second-host")));

        yield* Deferred.succeed(releasePairing, undefined);
        const first = yield* Fiber.join(firstFiber);
        yield* Effect.forEach(queuedSameTarget, Fiber.join, { discard: true });
        assert.equal(first.pairingToken, "PAIRING-CODE");
      }).pipe(
        Effect.ensuring(Deferred.succeed(releasePairing, undefined).pipe(Effect.ignore)),
        Effect.provide(layer),
        Effect.scoped,
      );
    }),
  );

  it.effect("limits concurrent SSH work across unrelated hosts", () =>
    Effect.gen(function* () {
      const fourResolutionsStarted = yield* Deferred.make<void>();
      const releaseResolutions = yield* Deferred.make<void>();
      let activeResolutions = 0;
      let maximumActiveResolutions = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-G")) {
            activeResolutions += 1;
            maximumActiveResolutions = Math.max(maximumActiveResolutions, activeResolutions);
            if (activeResolutions === 4) {
              yield* Deferred.succeed(fourResolutionsStarted, undefined).pipe(Effect.ignore);
            }
            yield* Deferred.await(releaseResolutions);
            activeResolutions -= 1;
            return makeSuccessfulProcess("\n");
          }
          if (args.includes("-N")) {
            return makeRunningProcess(() => undefined);
          }
          if (isManagedLaunchCommand(args)) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
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

      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const fibers = yield* Effect.forEach(
          Array.from({ length: 5 }, (_, index) => index),
          (index) =>
            Effect.forkChild(
              manager.ensureEnvironment({
                alias: `host-${index}`,
                hostname: `host-${index}.example.com`,
                username: "julius",
                port: 2222,
              }),
            ),
        );
        yield* Deferred.await(fourResolutionsStarted);
        yield* Effect.yieldNow;

        assert.equal(maximumActiveResolutions, 4);
        yield* Deferred.succeed(releaseResolutions, undefined);
        yield* Effect.forEach(fibers, Fiber.join, { discard: true });
        assert.equal(maximumActiveResolutions, 4);
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseResolutions, undefined).pipe(Effect.ignore)),
        Effect.provide(layer),
        Effect.scoped,
      );
    }),
  );
});

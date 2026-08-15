import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import { remoteStateKey } from "./command.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_LAUNCH_COMMAND_TIMEOUT_MS,
  REMOTE_PICK_PORT_SCRIPT,
  REMOTE_READY_TIMEOUT_MS,
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

const managedRuntimeChildSource = `const fs = require("node:fs");
const http = require("node:http");
const runtimePath = process.argv[1];
const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end("ok");
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { fs.unlinkSync(runtimePath); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.mkdirSync(require("node:path").dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify({
    version: 1,
    pid: process.pid,
    port,
    origin: "http://127.0.0.1:" + port,
    startedAt: "2026-08-09T05:10:06.000Z",
  }) + "\\n");
  process.stdout.write(String(port) + "\\n");
});`;

const managedRuntimeWrapperSource = `const { spawn } = require("node:child_process");
const childSource = process.argv[1];
const runtimePath = process.argv[2];
const child = spawn(process.execPath, ["-e", childSource, runtimePath], {
  stdio: ["ignore", "pipe", "inherit"],
});
child.stdout.setEncoding("utf8");
child.stdout.once("data", (value) => {
  process.stdout.write(String(child.pid) + " " + value.trim() + "\\n");
});
const stop = () => child.kill("SIGTERM");
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
child.once("exit", (code, signal) => {
  process.exit(code ?? (signal ? 0 : 1));
});
setInterval(() => {}, 1_000);`;

const installedServiceSource = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const runtimePath = process.argv[2];
const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end("service");
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { fs.unlinkSync(runtimePath); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify({
    version: 1,
    pid: process.pid,
    port,
    origin: "http://127.0.0.1:" + port,
    startedAt: "2026-08-09T05:10:06.000Z",
  }) + "\\n");
});`;

const fakeSystemctlSource = `#!/bin/sh
set -eu
if [ "\${1:-}" != "--user" ]; then
  exit 1
fi
case "\${2:-}:\${3:-}" in
  cat:t3code.service)
    exit 0
    ;;
  start:t3code.service)
    printf 'start\\n' >>"$FAKE_SERVICE_START_LOG"
    if [ -s "$FAKE_SERVICE_PID_FILE" ]; then
      EXISTING_PID="$(cat "$FAKE_SERVICE_PID_FILE")"
      if kill -0 "$EXISTING_PID" 2>/dev/null; then
        exit 0
      fi
    fi
    nohup "$FAKE_NODE" "$FAKE_SERVICE_SCRIPT" "$FAKE_RUNTIME_FILE" >>"$FAKE_SERVICE_LOG" 2>&1 < /dev/null &
    printf '%s\\n' "$!" >"$FAKE_SERVICE_PID_FILE"
    exit 0
    ;;
esac
exit 1
`;

const fakeUnavailableSystemctlSource = `#!/bin/sh
exit 1
`;

const stubbornUnavailableOwnerSource = `const net = require("node:net");
process.on("SIGTERM", () => {});
const server = net.createServer(() => {});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port) + "\\n");
});`;

const signalRecordingProcessSource = `const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(process.env.SIGNAL_MARKER, "signaled\\n");
  process.exit(0);
});
setInterval(() => {}, 1_000);`;

const postLaunchOwnershipRaceSource = `const fs = require("node:fs");
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end("managed");
});
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(process.env.RACE_MANAGED_PID_FILE, String(process.pid) + "\\n");
  fs.mkdirSync(require("node:path").dirname(process.env.RACE_RUNTIME_FILE), { recursive: true });
  fs.writeFileSync(process.env.RACE_RUNTIME_FILE, JSON.stringify({
    version: 1,
    pid: Number(process.env.RACE_EXTERNAL_PID),
    port: Number(process.env.RACE_EXTERNAL_PORT),
    origin: "http://127.0.0.1:" + process.env.RACE_EXTERNAL_PORT,
    startedAt: "2026-08-09T05:10:06.000Z",
  }) + "\\n");
});`;

const fakeInstalledServiceGuardSource = `#!/bin/sh
set -eu
if [ "\${1:-}" != "--user" ]; then
  exit 1
fi
case "\${2:-}:\${3:-}" in
  cat:t3code.service)
    exit 0
    ;;
  start:t3code.service)
    printf 'start\\n' >>"$FAKE_SERVICE_START_LOG"
    exit 1
    ;;
esac
exit 1
`;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const TestRuntimeState = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
});
const decodeTestRuntimeState = Schema.decodeUnknownSync(Schema.fromJsonString(TestRuntimeState));

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
    assert.include(buildRemoteStopScript(target), 'if [ "$REMOTE_MANAGED" = "managed" ]; then');
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
    assert.include(
      buildRemoteLaunchScript(),
      'is_descendant_or_same "$DEFAULT_RUNTIME_PID" "$REMOTE_PID"',
    );
    assert.include(
      buildRemoteLaunchScript(),
      'is_descendant_or_same "$STARTED_RUNTIME_PID" "$REMOTE_PID"',
    );
    assert.notInclude(
      buildRemoteLaunchScript(),
      '[ "$STARTED_RUNTIME_PORT" = "$REMOTE_PORT" ] && is_descendant_or_same',
    );
    assert.include(buildRemoteLaunchScript(), 'adopt_runtime_as_external "$STARTED_RUNTIME_INFO"');
    assert.include(buildRemoteLaunchScript(), "refusing dual ownership");
    assert.include(
      buildRemoteLaunchScript(),
      '[ "$PREVIOUS_REMOTE_PORT" != "$DEFAULT_REMOTE_PORT" ]',
    );
    assert.notInclude(buildRemoteLaunchScript(), "PID_TO_STOP");
    assert.include(buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(buildRemoteLaunchScript(), "DEFAULT_RUNTIME_IS_MANAGED=1");
    assert.include(buildRemoteLaunchScript(), '[ "$DEFAULT_RUNTIME_IS_MANAGED" -eq 0 ]');
    assert.include(buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.include(buildRemoteLaunchScript(), "refusing to replace it with a managed SSH server");
    assert.include(buildRemoteLaunchScript(), "systemctl --user cat t3code.service");
    assert.include(buildRemoteLaunchScript(), "systemctl --user start t3code.service");
    assert.include(buildRemoteStopScript(target), "systemctl --user start t3code.service");
    assert.notInclude(buildRemoteLaunchScript(), "RUNNER_CHANGED");
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  it("allows cold remote package installs to finish before launch times out", () => {
    assert.equal(REMOTE_READY_TIMEOUT_MS, 180_000);
    assert.isAbove(REMOTE_LAUNCH_COMMAND_TIMEOUT_MS, REMOTE_READY_TIMEOUT_MS);
    assert.include(buildRemoteLaunchScript(), `"${REMOTE_READY_TIMEOUT_MS}"`);
  });

  it.effect("reuses and normalizes a real managed parent-child runtime across an upgrade", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-launch-test-",
        });
        const stateKey = "managed-runtime";
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimeDir = path.join(home, ".t3", "userdata");
        const wrapper = yield* spawner.spawn(
          ChildProcess.make(
            executablePath,
            [
              "-e",
              managedRuntimeWrapperSource,
              managedRuntimeChildSource,
              path.join(runtimeDir, "server-runtime.json"),
            ],
            { detached: false },
          ),
        );
        yield* Effect.addFinalizer(() => wrapper.kill().pipe(Effect.catchCause(() => Effect.void)));

        const runtimeLine = yield* wrapper.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const [runtimePidText, portText] = Option.getOrThrow(runtimeLine).split(" ");
        const runtimePid = Number.parseInt(runtimePidText ?? "", 10);
        const port = Number.parseInt(portText ?? "", 10);
        assert.isTrue(Number.isInteger(runtimePid));
        assert.isTrue(Number.isInteger(port));
        assert.notEqual(runtimePid, wrapper.pid);
        assert.isTrue(processIsAlive(runtimePid));

        const fakeBin = path.join(home, "bin");
        const psPath = path.join(fakeBin, "ps");
        yield* fileSystem.makeDirectory(fakeBin, { recursive: true });
        yield* fileSystem.writeFileString(
          psPath,
          `#!/bin/sh
if [ "\${4:-}" = "${runtimePid}" ]; then
  printf '%s\\n' '${wrapper.pid}'
  exit 0
fi
exit 1
`,
        );
        yield* fileSystem.chmod(psPath, 0o755);

        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(stateDir, "managed"), "managed\n");
        yield* fileSystem.writeFileString(path.join(stateDir, "pid"), `${wrapper.pid}\n`);
        yield* fileSystem.writeFileString(path.join(stateDir, "port"), `${port}\n`);
        yield* fileSystem.writeFileString(
          path.join(stateDir, "run-t3.sh"),
          "#!/bin/sh\n# deliberately stale pre-upgrade runner\n",
        );

        const shell = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", stateKey], {
            detached: false,
            env: { HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(buildRemoteLaunchScript())),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(shell.stdout)),
            Stream.mkString(Stream.decodeText(shell.stderr)),
            shell.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0, stderr);
        assert.include(stdout, `{"remotePort":${port},"serverKind":"managed"}`);
        assert.isTrue(yield* wrapper.isRunning);
        assert.isTrue(processIsAlive(runtimePid));
        assert.equal(yield* fileSystem.readFileString(path.join(stateDir, "managed")), "managed\n");
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "pid")),
          `${runtimePid}\n`,
        );
        assert.equal(yield* fileSystem.readFileString(path.join(stateDir, "port")), `${port}\n`);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("reuses an externally owned runtime even when the SSH runner changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-external-runtime-test-",
        });
        const stateKey = "external-runtime";
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimeDir = path.join(home, ".t3", "userdata");
        const externalServer = yield* spawner.spawn(
          ChildProcess.make(
            executablePath,
            [
              "-e",
              `const http = require("node:http");
const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end("ok");
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));`,
            ],
            { detached: false },
          ),
        );
        yield* Effect.addFinalizer(() =>
          externalServer.kill().pipe(Effect.catchCause(() => Effect.void)),
        );

        const portLine = yield* externalServer.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const port = Number.parseInt(Option.getOrThrow(portLine), 10);
        assert.isTrue(Number.isInteger(port));

        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.makeDirectory(runtimeDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(stateDir, "run-t3.sh"),
          "#!/bin/sh\n# deliberately stale runner\n",
        );
        yield* fileSystem.writeFileString(
          path.join(runtimeDir, "server-runtime.json"),
          `{"version":1,"pid":${externalServer.pid},"port":${port},"origin":"http://127.0.0.1:${port}","startedAt":"2026-08-09T05:10:06.000Z"}\n`,
        );

        const shell = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", stateKey], {
            detached: false,
            env: { HOME: home },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(buildRemoteLaunchScript())),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(shell.stdout)),
            Stream.mkString(Stream.decodeText(shell.stderr)),
            shell.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0, stderr);
        assert.include(stdout, `{"remotePort":${port},"serverKind":"external"}`);
        assert.isTrue(yield* externalServer.isRunning);
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "managed")),
          "external\n",
        );
        assert.equal(yield* fileSystem.readFileString(path.join(stateDir, "port")), `${port}\n`);
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "pid")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("fails closed while a live external owner is temporarily unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-external-unavailable-test-",
        });
        const stateKey = "external-unavailable";
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimeDir = path.join(home, ".t3", "userdata");
        const unavailableOwner = yield* spawner.spawn(
          ChildProcess.make(
            executablePath,
            [
              "-e",
              `const net = require("node:net");
const server = net.createServer(() => {});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));`,
            ],
            { detached: false },
          ),
        );
        yield* Effect.addFinalizer(() =>
          unavailableOwner.kill().pipe(Effect.catchCause(() => Effect.void)),
        );
        const portLine = yield* unavailableOwner.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const port = Number.parseInt(Option.getOrThrow(portLine), 10);
        yield* fileSystem.makeDirectory(runtimeDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(runtimeDir, "server-runtime.json"),
          `{"version":1,"pid":${unavailableOwner.pid},"port":${port},"origin":"http://127.0.0.1:${port}","startedAt":"2026-08-09T05:10:06.000Z"}\n`,
        );

        const shell = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", stateKey], {
            detached: false,
            env: { HOME: home },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(buildRemoteLaunchScript())),
          }),
        );
        const [stderr, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(shell.stderr)), shell.exitCode],
          { concurrency: "unbounded" },
        );

        assert.notEqual(exitCode, 0);
        assert.include(stderr, "refusing to start a competing SSH server");
        assert.isTrue(yield* unavailableOwner.isRunning);
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "pid")));
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "managed")));
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "server.log")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("never signals a live PID without runtime ownership proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-unverified-pid-test-",
        });
        const target = {
          alias: "unverified-pid",
          hostname: "unverified.example.com",
          username: "tester",
          port: 22,
        } as const;
        const stateKey = remoteStateKey(target);
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const signalMarker = path.join(home, "signal-marker");
        const unrelatedProcess = yield* spawner.spawn(
          ChildProcess.make(executablePath, ["-e", signalRecordingProcessSource], {
            detached: false,
            env: { SIGNAL_MARKER: signalMarker },
            extendEnv: true,
          }),
        );
        yield* Effect.addFinalizer(() =>
          unrelatedProcess.kill().pipe(Effect.catchCause(() => Effect.void)),
        );

        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(stateDir, "managed"), "managed\n");
        yield* fileSystem.writeFileString(path.join(stateDir, "pid"), `${unrelatedProcess.pid}\n`);
        yield* fileSystem.writeFileString(path.join(stateDir, "port"), "61234\n");

        const launch = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", stateKey], {
            detached: false,
            env: { HOME: home, SIGNAL_MARKER: signalMarker },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(buildRemoteLaunchScript())),
          }),
        );
        const [launchStderr, launchExitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(launch.stderr)), launch.exitCode],
          { concurrency: "unbounded" },
        );
        assert.notEqual(launchExitCode, 0);
        assert.include(launchStderr, "runtime ownership cannot be verified");
        assert.isTrue(yield* unrelatedProcess.isRunning);
        assert.isFalse(yield* fileSystem.exists(signalMarker));

        const stop = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s"], {
            detached: false,
            env: { HOME: home, SIGNAL_MARKER: signalMarker },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(buildRemoteStopScript(target))),
          }),
        );
        const [stopStderr, stopExitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(stop.stderr)), stop.exitCode],
          { concurrency: "unbounded" },
        );
        assert.notEqual(stopExitCode, 0);
        assert.include(stopStderr, "runtime ownership cannot be verified");
        assert.isTrue(yield* unrelatedProcess.isRunning);
        assert.isFalse(yield* fileSystem.exists(signalMarker));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("preserves ownership when a managed child refuses to terminate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-stubborn-owner-test-",
        });
        const target = {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        } as const;
        const stateKey = remoteStateKey(target);
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimeDir = path.join(home, ".t3", "userdata");
        const runtimePath = path.join(runtimeDir, "server-runtime.json");
        const fakeBin = path.join(home, "fake-bin");
        const systemctlPath = path.join(fakeBin, "systemctl");
        const serviceStartLogPath = path.join(home, "fake-service-starts.log");
        const stubbornOwner = yield* spawner.spawn(
          ChildProcess.make(executablePath, ["-e", stubbornUnavailableOwnerSource], {
            detached: false,
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(stubbornOwner.pid, "SIGKILL");
            } catch {}
          }).pipe(Effect.andThen(stubbornOwner.exitCode), Effect.ignore),
        );
        const portLine = yield* stubbornOwner.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const port = Number.parseInt(Option.getOrThrow(portLine), 10);

        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.makeDirectory(runtimeDir, { recursive: true });
        yield* fileSystem.makeDirectory(fakeBin, { recursive: true });
        yield* fileSystem.writeFileString(systemctlPath, fakeInstalledServiceGuardSource);
        yield* fileSystem.chmod(systemctlPath, 0o755);
        yield* fileSystem.writeFileString(path.join(stateDir, "managed"), "managed\n");
        yield* fileSystem.writeFileString(path.join(stateDir, "pid"), `${stubbornOwner.pid}\n`);
        yield* fileSystem.writeFileString(path.join(stateDir, "port"), `${port}\n`);
        yield* fileSystem.writeFileString(
          runtimePath,
          `{"version":1,"pid":${stubbornOwner.pid},"port":${port},"origin":"http://127.0.0.1:${port}","startedAt":"2026-08-09T05:10:06.000Z"}\n`,
        );

        const shellEnvironment = {
          HOME: home,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          FAKE_SERVICE_START_LOG: serviceStartLogPath,
        };
        const runScript = (script: string, args: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const shell = yield* spawner.spawn(
              ChildProcess.make("sh", args, {
                detached: false,
                env: shellEnvironment,
                extendEnv: true,
                stdin: Stream.make(new TextEncoder().encode(script)),
              }),
            );
            return yield* Effect.all(
              [Stream.mkString(Stream.decodeText(shell.stderr)), shell.exitCode],
              { concurrency: "unbounded" },
            );
          });

        const [launchStderr, launchExitCode] = yield* runScript(buildRemoteLaunchScript(), [
          "-s",
          "--",
          stateKey,
        ]);
        assert.notEqual(launchExitCode, 0);
        assert.include(launchStderr, "did not terminate");
        assert.isTrue(processIsAlive(stubbornOwner.pid));
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "pid")),
          `${stubbornOwner.pid}\n`,
        );
        assert.equal(yield* fileSystem.readFileString(path.join(stateDir, "managed")), "managed\n");
        assert.isFalse(yield* fileSystem.exists(serviceStartLogPath));

        const [stopStderr, stopExitCode] = yield* runScript(buildRemoteStopScript(target), ["-s"]);
        assert.notEqual(stopExitCode, 0);
        assert.include(stopStderr, "did not terminate after explicit disconnect");
        assert.isTrue(processIsAlive(stubbornOwner.pid));
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "pid")),
          `${stubbornOwner.pid}\n`,
        );
        assert.equal(yield* fileSystem.readFileString(path.join(stateDir, "managed")), "managed\n");
        assert.equal(yield* fileSystem.readFileString(path.join(stateDir, "port")), `${port}\n`);
        assert.isFalse(yield* fileSystem.exists(serviceStartLogPath));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("converges a competing managed runtime onto the external owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-owner-convergence-test-",
        });
        const stateKey = "owner-convergence";
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimeDir = path.join(home, ".t3", "userdata");

        const startServer = () =>
          spawner.spawn(
            ChildProcess.make(
              executablePath,
              [
                "-e",
                `const http = require("node:http");
const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end("ok");
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));`,
              ],
              { detached: false },
            ),
          );
        const managedServer = yield* startServer();
        const externalServer = yield* startServer();
        yield* Effect.addFinalizer(() =>
          managedServer.kill().pipe(Effect.catchCause(() => Effect.void)),
        );
        yield* Effect.addFinalizer(() =>
          externalServer.kill().pipe(Effect.catchCause(() => Effect.void)),
        );

        const managedPortLine = yield* managedServer.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const externalPortLine = yield* externalServer.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const managedPort = Number.parseInt(Option.getOrThrow(managedPortLine), 10);
        const externalPort = Number.parseInt(Option.getOrThrow(externalPortLine), 10);
        assert.isTrue(Number.isInteger(managedPort));
        assert.isTrue(Number.isInteger(externalPort));
        assert.notEqual(managedPort, externalPort);

        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.makeDirectory(runtimeDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(stateDir, "managed"), "managed\n");
        yield* fileSystem.writeFileString(path.join(stateDir, "pid"), `${managedServer.pid}\n`);
        yield* fileSystem.writeFileString(path.join(stateDir, "port"), `${managedPort}\n`);
        yield* fileSystem.writeFileString(
          path.join(stateDir, "run-t3.sh"),
          `${buildRemoteT3RunnerScript()}\n`,
        );
        yield* fileSystem.writeFileString(
          path.join(runtimeDir, "server-runtime.json"),
          `{"version":1,"pid":${externalServer.pid},"port":${externalPort},"origin":"http://127.0.0.1:${externalPort}","startedAt":"2026-08-09T05:10:06.000Z"}\n`,
        );

        const shell = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", stateKey], {
            detached: false,
            env: { HOME: home },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(buildRemoteLaunchScript())),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(shell.stdout)),
            Stream.mkString(Stream.decodeText(shell.stderr)),
            shell.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0, stderr);
        assert.include(stdout, `{"remotePort":${externalPort},"serverKind":"external"}`);
        assert.isFalse(yield* managedServer.isRunning);
        assert.isTrue(yield* externalServer.isRunning);
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "managed")),
          "external\n",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "port")),
          `${externalPort}\n`,
        );
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "pid")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("adopts an external owner that appears after the managed launch begins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-post-launch-owner-race-test-",
        });
        const stateKey = "post-launch-owner-race";
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimePath = path.join(home, ".t3", "userdata", "server-runtime.json");
        const managedPidPath = path.join(home, "managed.pid");
        const raceServerPath = path.join(home, "post-launch-race-server.cjs");
        const fakeBin = path.join(home, "fake-bin");
        const systemctlPath = path.join(fakeBin, "systemctl");

        const externalServer = yield* spawner.spawn(
          ChildProcess.make(
            executablePath,
            [
              "-e",
              `const http = require("node:http");
const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end("external");
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));`,
            ],
            { detached: false },
          ),
        );
        yield* Effect.addFinalizer(() =>
          externalServer.kill().pipe(Effect.catchCause(() => Effect.void)),
        );
        const externalPortLine = yield* externalServer.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const externalPort = Number.parseInt(Option.getOrThrow(externalPortLine), 10);
        assert.isTrue(Number.isInteger(externalPort));
        yield* fileSystem.makeDirectory(fakeBin, { recursive: true });
        yield* fileSystem.writeFileString(systemctlPath, fakeUnavailableSystemctlSource);
        yield* fileSystem.chmod(systemctlPath, 0o755);
        yield* fileSystem.writeFileString(raceServerPath, postLaunchOwnershipRaceSource);

        const shell = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", stateKey], {
            detached: false,
            env: {
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
              RACE_RUNTIME_FILE: runtimePath,
              RACE_MANAGED_PID_FILE: managedPidPath,
              RACE_EXTERNAL_PID: String(externalServer.pid),
              RACE_EXTERNAL_PORT: String(externalPort),
            },
            extendEnv: true,
            stdin: Stream.make(
              new TextEncoder().encode(buildRemoteLaunchScript({ nodeScriptPath: raceServerPath })),
            ),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(shell.stdout)),
            Stream.mkString(Stream.decodeText(shell.stderr)),
            shell.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        const managedPid = Number.parseInt(
          (yield* fileSystem.readFileString(managedPidPath)).trim(),
          10,
        );
        assert.equal(exitCode, 0, stderr);
        assert.include(stdout, `{"remotePort":${externalPort},"serverKind":"external"}`);
        assert.isFalse(processIsAlive(managedPid));
        assert.isTrue(yield* externalServer.isRunning);
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "managed")),
          "external\n",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "port")),
          `${externalPort}\n`,
        );
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "pid")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("does not adopt or signal a reused managed PID on the external runtime port", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-pid-reuse-test-",
        });
        const stateKey = "pid-reuse";
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimeDir = path.join(home, ".t3", "userdata");

        const externalServer = yield* spawner.spawn(
          ChildProcess.make(
            executablePath,
            [
              "-e",
              `const http = require("node:http");
const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end("ok");
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));`,
            ],
            { detached: false },
          ),
        );
        const unrelatedProcess = yield* spawner.spawn(
          ChildProcess.make(executablePath, ["-e", "setInterval(() => {}, 1_000)"], {
            detached: false,
          }),
        );
        yield* Effect.addFinalizer(() =>
          externalServer.kill().pipe(Effect.catchCause(() => Effect.void)),
        );
        yield* Effect.addFinalizer(() =>
          unrelatedProcess.kill().pipe(Effect.catchCause(() => Effect.void)),
        );

        const portLine = yield* externalServer.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const port = Number.parseInt(Option.getOrThrow(portLine), 10);
        assert.isTrue(Number.isInteger(port));

        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.makeDirectory(runtimeDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(stateDir, "managed"), "managed\n");
        yield* fileSystem.writeFileString(path.join(stateDir, "pid"), `${unrelatedProcess.pid}\n`);
        yield* fileSystem.writeFileString(path.join(stateDir, "port"), `${port}\n`);
        yield* fileSystem.writeFileString(
          path.join(stateDir, "run-t3.sh"),
          `${buildRemoteT3RunnerScript()}\n`,
        );
        yield* fileSystem.writeFileString(
          path.join(runtimeDir, "server-runtime.json"),
          `{"version":1,"pid":${externalServer.pid},"port":${port},"origin":"http://127.0.0.1:${port}","startedAt":"2026-08-09T05:10:06.000Z"}\n`,
        );

        const shell = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", stateKey], {
            detached: false,
            env: { HOME: home },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(buildRemoteLaunchScript())),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(shell.stdout)),
            Stream.mkString(Stream.decodeText(shell.stderr)),
            shell.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0, stderr);
        assert.include(stdout, `{"remotePort":${port},"serverKind":"external"}`);
        assert.isTrue(yield* externalServer.isRunning);
        assert.isTrue(yield* unrelatedProcess.isRunning);
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "managed")),
          "external\n",
        );
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "pid")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("starts and adopts an inactive installed service before spawning an SSH runner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-service-adoption-test-",
        });
        const stateKey = "service-adoption";
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimePath = path.join(home, ".t3", "userdata", "server-runtime.json");
        const fakeBin = path.join(home, "fake-bin");
        const systemctlPath = path.join(fakeBin, "systemctl");
        const serviceScriptPath = path.join(home, "fake-t3-service.cjs");
        const servicePidPath = path.join(home, "fake-t3-service.pid");
        const serviceLogPath = path.join(home, "fake-t3-service.log");
        const serviceStartLogPath = path.join(home, "fake-t3-service-starts.log");

        yield* fileSystem.makeDirectory(fakeBin, { recursive: true });
        yield* fileSystem.writeFileString(systemctlPath, fakeSystemctlSource);
        yield* fileSystem.chmod(systemctlPath, 0o755);
        yield* fileSystem.writeFileString(serviceScriptPath, installedServiceSource);

        const shellEnvironment = {
          HOME: home,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          FAKE_NODE: executablePath,
          FAKE_SERVICE_SCRIPT: serviceScriptPath,
          FAKE_RUNTIME_FILE: runtimePath,
          FAKE_SERVICE_PID_FILE: servicePidPath,
          FAKE_SERVICE_LOG: serviceLogPath,
          FAKE_SERVICE_START_LOG: serviceStartLogPath,
        };
        const runLaunch = () =>
          Effect.gen(function* () {
            const shell = yield* spawner.spawn(
              ChildProcess.make("sh", ["-s", "--", stateKey], {
                detached: false,
                env: shellEnvironment,
                extendEnv: true,
                stdin: Stream.make(new TextEncoder().encode(buildRemoteLaunchScript())),
              }),
            );
            return yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(shell.stdout)),
                Stream.mkString(Stream.decodeText(shell.stderr)),
                shell.exitCode,
              ],
              { concurrency: "unbounded" },
            );
          });

        const [firstStdout, firstStderr, firstExitCode] = yield* runLaunch();
        assert.equal(firstExitCode, 0, firstStderr);

        const runtime = decodeTestRuntimeState(yield* fileSystem.readFileString(runtimePath));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(runtime.pid, "SIGTERM");
            } catch {}
          }),
        );
        assert.include(firstStdout, `{"remotePort":${runtime.port},"serverKind":"external"}`);
        assert.isTrue(processIsAlive(runtime.pid));
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "managed")),
          "external\n",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "port")),
          `${runtime.port}\n`,
        );
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "pid")));

        const [secondStdout, secondStderr, secondExitCode] = yield* runLaunch();
        assert.equal(secondExitCode, 0, secondStderr);
        assert.include(secondStdout, `{"remotePort":${runtime.port},"serverKind":"external"}`);
        assert.equal(yield* fileSystem.readFileString(serviceStartLogPath), "start\n");
        assert.equal(
          Number.parseInt(yield* fileSystem.readFileString(servicePidPath), 10),
          runtime.pid,
        );
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "server.log")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("stops only its managed runtime, then activates and adopts the installed service", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-stop-service-handoff-test-",
        });
        const target = {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        } as const;
        const stateKey = remoteStateKey(target);
        const stateDir = path.join(home, ".t3", "ssh-launch", stateKey);
        const runtimePath = path.join(home, ".t3", "userdata", "server-runtime.json");
        const fakeBin = path.join(home, "fake-bin");
        const systemctlPath = path.join(fakeBin, "systemctl");
        const psPath = path.join(fakeBin, "ps");
        const serviceScriptPath = path.join(home, "fake-t3-service.cjs");
        const servicePidPath = path.join(home, "fake-t3-service.pid");
        const serviceLogPath = path.join(home, "fake-t3-service.log");
        const serviceStartLogPath = path.join(home, "fake-t3-service-starts.log");

        const wrapper = yield* spawner.spawn(
          ChildProcess.make(
            executablePath,
            ["-e", managedRuntimeWrapperSource, managedRuntimeChildSource, runtimePath],
            { detached: false },
          ),
        );
        const unrelated = yield* spawner.spawn(
          ChildProcess.make(executablePath, ["-e", "setInterval(() => {}, 1_000)"], {
            detached: false,
          }),
        );
        yield* Effect.addFinalizer(() => wrapper.kill().pipe(Effect.catchCause(() => Effect.void)));
        yield* Effect.addFinalizer(() =>
          unrelated.kill().pipe(Effect.catchCause(() => Effect.void)),
        );

        const runtimeLine = yield* wrapper.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const [managedPidText, managedPortText] = Option.getOrThrow(runtimeLine).split(" ");
        const managedPid = Number.parseInt(managedPidText ?? "", 10);
        const managedPort = Number.parseInt(managedPortText ?? "", 10);
        assert.isTrue(processIsAlive(managedPid));

        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(stateDir, "managed"), "managed\n");
        yield* fileSystem.writeFileString(path.join(stateDir, "pid"), `${wrapper.pid}\n`);
        yield* fileSystem.writeFileString(path.join(stateDir, "port"), `${managedPort}\n`);
        yield* fileSystem.makeDirectory(fakeBin, { recursive: true });
        yield* fileSystem.writeFileString(systemctlPath, fakeSystemctlSource);
        yield* fileSystem.chmod(systemctlPath, 0o755);
        yield* fileSystem.writeFileString(
          psPath,
          `#!/bin/sh
if [ "\${4:-}" = "${managedPid}" ]; then
  printf '%s\\n' '${wrapper.pid}'
  exit 0
fi
exit 1
`,
        );
        yield* fileSystem.chmod(psPath, 0o755);
        yield* fileSystem.writeFileString(serviceScriptPath, installedServiceSource);

        const shell = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s"], {
            detached: false,
            env: {
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
              FAKE_NODE: executablePath,
              FAKE_SERVICE_SCRIPT: serviceScriptPath,
              FAKE_RUNTIME_FILE: runtimePath,
              FAKE_SERVICE_PID_FILE: servicePidPath,
              FAKE_SERVICE_LOG: serviceLogPath,
              FAKE_SERVICE_START_LOG: serviceStartLogPath,
            },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(buildRemoteStopScript(target))),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(shell.stdout)),
            Stream.mkString(Stream.decodeText(shell.stderr)),
            shell.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0, stderr);
        assert.include(stdout, '{"stopped":true}');
        const serviceRuntime = decodeTestRuntimeState(
          yield* fileSystem.readFileString(runtimePath),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(serviceRuntime.pid, "SIGTERM");
            } catch {}
          }),
        );
        assert.isFalse(processIsAlive(managedPid));
        assert.isTrue(yield* unrelated.isRunning);
        assert.isTrue(processIsAlive(serviceRuntime.pid));
        assert.equal(yield* fileSystem.readFileString(serviceStartLogPath), "start\n");
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "managed")),
          "external\n",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(stateDir, "port")),
          `${serviceRuntime.port}\n`,
        );
        assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "pid")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

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

  it.effect("manager scope shutdown closes only the local tunnel and preserves remote work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
        const executablePath = yield* HostProcessExecutablePath;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ssh-manager-shutdown-test-",
        });
        const runtimePath = path.join(home, ".t3", "userdata", "server-runtime.json");
        const wrapper = yield* spawnerService.spawn(
          ChildProcess.make(
            executablePath,
            ["-e", managedRuntimeWrapperSource, managedRuntimeChildSource, runtimePath],
            { detached: false },
          ),
        );
        yield* Effect.addFinalizer(() => wrapper.kill().pipe(Effect.catchCause(() => Effect.void)));
        const runtimeLine = yield* wrapper.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        const [runtimePidText, remotePortText] = Option.getOrThrow(runtimeLine).split(" ");
        const runtimePid = Number.parseInt(runtimePidText ?? "", 10);
        const remotePort = Number.parseInt(remotePortText ?? "", 10);
        let tunnelKillCount = 0;
        let stopCommandCount = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-N")) {
              return makeRunningProcess(() => {
                tunnelKillCount += 1;
              });
            }
            if (args.includes("sh") && args.includes("--")) {
              return makeSuccessfulProcess(`{"remotePort":${remotePort},"serverKind":"managed"}\n`);
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
          SshEnvironmentManager.layer({ resolveCliPackageSpec: () => "t3@upgraded" }),
        );
        const target = {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        } as const;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* SshEnvironmentManager;
            yield* manager.ensureEnvironment(target);
          }).pipe(Effect.provide(layer)),
        );

        assert.equal(tunnelKillCount, 1);
        assert.equal(stopCommandCount, 0);
        assert.isTrue(yield* wrapper.isRunning);
        assert.isTrue(processIsAlive(runtimePid));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("stale local tunnel recovery preserves the remote runtime", () => {
    let localTunnelReady = true;
    let remoteLaunchCount = 0;
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const conditionalHttpClient = HttpClient.make((request) =>
      localTunnelReady
        ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })))
        : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 503 }))),
    );
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-N")) {
          localTunnelReady = true;
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          remoteLaunchCount += 1;
          return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}\n');
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
      Layer.succeed(HttpClient.HttpClient, conditionalHttpClient),
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

    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        yield* manager.ensureEnvironment(target);
        localTunnelReady = false;
        const reconnectFiber = yield* Effect.forkChild(manager.ensureEnvironment(target));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(2_500));
        yield* Fiber.join(reconnectFiber);

        assert.equal(remoteLaunchCount, 2);
        assert.equal(tunnelKillCount, 1);
        assert.equal(stopCommandCount, 0);
      }).pipe(Effect.provide(layer)),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          assert.equal(tunnelKillCount, 2);
          assert.equal(stopCommandCount, 0);
        }),
      ),
    );
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
});

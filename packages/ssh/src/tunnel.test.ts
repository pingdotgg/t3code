import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
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

// A tunnel reports its agent-holding session as ready on stdout.
const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(new TextEncoder().encode("t3-ssh-tunnel-session-ready\n")),
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

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-L")
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
          commandArgs(command).includes("-L")
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

  it.effect("waits for the tunnel session before reporting the environment ready", () =>
    Effect.gen(function* () {
      const httpChecked = yield* Deferred.make<void>();
      const sessionReady = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-L")
            ? {
                ...makeRunningProcess(() => undefined),
                stdout: Stream.fromEffect(Deferred.await(sessionReady)).pipe(
                  Stream.map(() => new TextEncoder().encode("t3-ssh-tunnel-session-ready\n")),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const httpClient = HttpClient.make((request) =>
        Deferred.succeed(httpChecked, undefined).pipe(
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
        const ensure = yield* Effect.forkChild(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        yield* Deferred.await(httpChecked);
        yield* TestClock.adjust(Duration.zero);
        assert.isUndefined(ensure.pollUnsafe());
        yield* Deferred.succeed(sessionReady, undefined);
        yield* Fiber.join(ensure);
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
            if (args.includes("-L")) {
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

// Stands in for ssh plus the remote sshd. Like sshd, a connection that
// forwards the agent gets its own socket that lives only as long as its
// session; `-N` opens no session, so it gets no socket at all.
const FAKE_SSH_SCRIPT = `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const args = process.argv.slice(2);
if (args.includes("-G")) {
  process.stdout.write("hostname devbox\\nuser t3\\nport 22\\nforwardagent " + config.forwardAgent + "\\n");
  process.exit(0);
}
const hostIndex = args.indexOf("--") + 1;
const options = args.slice(0, hostIndex);
const remoteCommand = args.slice(hostIndex + 1).join(" ");
let forwardAgent = config.forwardAgent === "yes";
options.forEach((arg, index) => {
  if (arg === "-A") forwardAgent = true;
  if (arg === "-a") forwardAgent = false;
  const match = options[index - 1] === "-o" ? /^forwardagent[= ](.*)$/i.exec(arg) : null;
  if (match) forwardAgent = match[1].trim().toLowerCase() === "yes";
});
const hasSession = !options.includes("-N");
fs.appendFileSync(config.connectionsLog, JSON.stringify({ forwardAgent, hasSession }) + "\\n");
if (!hasSession) {
  setInterval(() => {}, 1 << 30);
  return;
}
const env = { ...process.env, HOME: config.home };
delete env.SSH_AUTH_SOCK;
const agentDir = fs.mkdtempSync(path.join(config.root, "ssh-"));
const agent = net.createServer((socket) => socket.end());
const run = () => {
  // sshd runs each session in its own process session.
  const child = spawn("sh", ["-c", remoteCommand], {
    detached: true,
    env,
    stdio: [options.includes("-n") ? "ignore" : "pipe", "inherit", "inherit"],
  });
  if (child.stdin) process.stdin.pipe(child.stdin);
  const close = (code) => {
    agent.close();
    fs.rmSync(agentDir, { recursive: true, force: true });
    process.exit(code);
  };
  child.on("exit", (code) => close(code ?? 1));
  // A dropped connection hangs up its session, as sshd does.
  process.on("SIGTERM", () => {
    try {
      process.kill(-child.pid, "SIGHUP");
    } catch {}
    close(143);
  });
};
if (forwardAgent) {
  env.SSH_AUTH_SOCK = path.join(agentDir, "agent." + process.pid);
  agent.listen(env.SSH_AUTH_SOCK, run);
} else {
  run();
}
`;

// Stands in for the remote t3 server and records the agent socket it inherited.
const FAKE_SERVER_SCRIPT = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
fs.writeFileSync(
  path.join(option("--base-dir"), "fake-server.json"),
  JSON.stringify({ pid: process.pid, authSock: process.env.SSH_AUTH_SOCK ?? null }),
);
http.createServer((_request, response) => response.end("ok")).listen(Number(option("--port")), option("--host"));
`;

const canConnectToSocket = (socketPath: string | null) =>
  Effect.callback<boolean>((resume) => {
    if (socketPath === null) {
      resume(Effect.succeed(false));
      return;
    }
    const socket = NodeNet.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => resume(Effect.succeed(false)));
  });

const makeForwardedAgentHarness = Effect.fn("makeForwardedAgentHarness")(function* (
  forwardAgent: "yes" | "no",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-agent-" });
  const home = path.join(root, "home");
  yield* fs.makeDirectory(home);
  const connectionsLog = path.join(root, "connections.jsonl");
  yield* fs.writeFileString(
    path.join(root, "config.json"),
    JSON.stringify({ forwardAgent, home, root, connectionsLog }),
  );
  const fakeSsh = path.join(root, "ssh.cjs");
  yield* fs.writeFileString(fakeSsh, FAKE_SSH_SCRIPT);
  const nodeScriptPath = path.join(root, "server.cjs");
  yield* fs.writeFileString(nodeScriptPath, FAKE_SERVER_SCRIPT);
  const readServer = fs
    .readFileString(path.join(home, ".t3", "fake-server.json"))
    .pipe(
      Effect.map(
        (raw) => JSON.parse(raw) as { readonly pid: number; readonly authSock: string | null },
      ),
    );
  yield* Effect.addFinalizer(() =>
    readServer.pipe(
      // The manager normally stops it first; this only covers a failed test.
      Effect.flatMap((server) => Effect.try(() => process.kill(server.pid, "SIGKILL"))),
      Effect.ignore,
    ),
  );
  const readConnections = fs.readFileString(connectionsLog).pipe(
    Effect.map((raw) =>
      raw
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { readonly forwardAgent: boolean; readonly hasSession: boolean },
        ),
    ),
  );
  return { fakeSsh, nodeScriptPath, readServer, readConnections };
});

const forwardedAgentLayer = (input: {
  readonly fakeSsh: string;
  readonly nodeScriptPath: string;
  readonly staleBaseUrls: Set<string>;
}) => {
  let nextLocalPort = 41_800;
  const spawnerLayer = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        real.spawn(
          command._tag === "StandardCommand" &&
            (command.command === "ssh" || command.command === "ssh.exe")
            ? ChildProcess.make(process.execPath, [input.fakeSsh, ...command.args], command.options)
            : command,
        ),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    NodeServices.layer,
    spawnerLayer,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("", {
              status: [...input.staleBaseUrls].some((url) => request.url.startsWith(url))
                ? 503
                : 200,
            }),
          ),
        ),
      ),
    ),
    Layer.succeed(NetService.NetService, {
      ...testNetService,
      reserveLoopbackPort: () => Effect.sync(() => nextLocalPort++),
    }),
    SshAuth.SshPasswordPrompt.disabledLayer,
  ).pipe((layer) =>
    Layer.provideMerge(
      SshTunnel.SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed({ nodeScriptPath: input.nodeScriptPath }),
      }),
      layer,
    ),
  );
};

// The fake sshd needs sh, process-group signals, and Unix socket agent paths.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "managed server forwarded agent",
  () => {
    const target = { alias: "devbox", hostname: "devbox", username: null, port: null };

    // Reproduces https://git.cafe/pingdotgg/t3code/issues/11872: the managed
    // server kept the launch connection's agent socket, which sshd deletes as
    // soon as the launch command exits, so git over SSH failed on the remote.
    it.live(
      "keeps the forwarded agent reachable from the managed server while connected and across reconnect",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeForwardedAgentHarness("yes").pipe(
            Effect.provide(NodeServices.layer),
          );
          const staleBaseUrls = new Set<string>();
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            const first = yield* manager.ensureEnvironment(target);
            const launched = yield* harness.readServer;
            const agentAfterLaunch = yield* canConnectToSocket(launched.authSock);

            // A dropped local forward makes the next ensure reconnect and reuse
            // the still-running server.
            staleBaseUrls.add(first.httpBaseUrl);
            const second = yield* manager.ensureEnvironment(target);
            const reused = yield* harness.readServer;
            const agentAfterReconnect = yield* canConnectToSocket(reused.authSock);

            assert.notEqual(second.httpBaseUrl, first.httpBaseUrl);
            assert.deepEqual(
              {
                sameServer: reused.pid === launched.pid,
                agentAfterLaunch,
                agentAfterReconnect,
              },
              { sameServer: true, agentAfterLaunch: true, agentAfterReconnect: true },
              `managed server SSH_AUTH_SOCK=${String(reused.authSock)}`,
            );
          }).pipe(Effect.provide(forwardedAgentLayer({ ...harness, staleBaseUrls })));
        }).pipe(Effect.scoped),
    );

    it.live("forwards no agent when the SSH config does not enable ForwardAgent", () =>
      Effect.gen(function* () {
        const harness = yield* makeForwardedAgentHarness("no").pipe(
          Effect.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          assert.isNull((yield* harness.readServer).authSock);
          const connections = yield* harness.readConnections;
          assert.isFalse(connections.some((connection) => connection.forwardAgent));
        }).pipe(
          Effect.provide(forwardedAgentLayer({ ...harness, staleBaseUrls: new Set<string>() })),
        );
      }).pipe(Effect.scoped),
    );
  },
);

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

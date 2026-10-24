import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("launch script", () => {
  // Stands in for `t3 serve`: answers HTTP and writes its home's runtime file.
  // An \`unready\` file in its home makes it answer 503, like a stuck server.
  const FAKE_SERVER = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const baseDir = flag("--base-dir");
const server = http.createServer((_request, response) => {
  response.statusCode = fs.existsSync(path.join(baseDir, "unready")) ? 503 : 200;
  response.end();
});
server.listen(Number(flag("--port")), "127.0.0.1", () => {
  const port = server.address().port;
  console.log(port);
  const userdata = path.join(baseDir, "userdata");
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(
    path.join(userdata, "server-runtime.json"),
    JSON.stringify({ version: 1, pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
  );
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

  const prepareLaunch = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-script-" });
    const home = `${root}/home`;
    const fakeServer = `${root}/fake-t3.cjs`;
    const launchScript = `${root}/launch.sh`;
    yield* fs.makeDirectory(home);
    yield* fs.writeFileString(fakeServer, FAKE_SERVER);
    yield* fs.writeFileString(
      launchScript,
      SshTunnel.buildRemoteLaunchScript({ nodeScriptPath: fakeServer }),
    );
    const stateDir = (stateKey: string) => `${home}/.t3/ssh-launch/${stateKey}`;
    const readManagedPid = (stateKey: string) =>
      fs.readFileString(`${stateDir(stateKey)}/pid`).pipe(Effect.map((pid) => Number(pid.trim())));
    // Launched servers outlive the script.
    const launchedPids = new Set<number>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const pid of launchedPids) {
          if (isAlive(pid)) process.kill(pid, "SIGKILL");
        }
      }),
    );
    const launch = (
      stateKey: string,
      gate?: {
        readonly onLine: (line: string) => Effect.Effect<void>;
        readonly release: Effect.Effect<void>;
      },
    ) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", [launchScript, stateKey], {
            ...(gate
              ? {
                  stdin: Stream.fromEffect(
                    gate.release.pipe(Effect.as(new TextEncoder().encode("go\n"))),
                  ),
                }
              : {}),
            env: { PATH: process.env.PATH ?? "", HOME: home },
            extendEnv: false,
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.tap((line) => gate?.onLine(line) ?? Effect.void),
              Stream.map((line) => `${line}\n`),
              Stream.mkString,
            ),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(exitCode, 0, stderr);
        const pid = yield* readManagedPid(stateKey).pipe(Effect.orElseSucceed(() => null));
        if (pid !== null) launchedPids.add(pid);
        return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
          remotePort: number;
          serverKind: string;
        };
      });
    const stop = (stateKey: string) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s"], {
            stdin: Stream.make(new TextEncoder().encode(SshTunnel.buildRemoteStopScript(stateKey))),
            env: { PATH: process.env.PATH ?? "", HOME: home },
            extendEnv: false,
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(exitCode, 0, stderr);
        assert.deepEqual(JSON.parse(stdout), { stopped: true });
      });
    // A live server this key manages, outside the default home.
    const startOwnServer = (stateKey: string, runnerFrom: string) =>
      Effect.gen(function* () {
        const server = yield* spawner.spawn(
          ChildProcess.make("node", [
            fakeServer,
            "serve",
            "--port",
            "0",
            "--base-dir",
            `${root}/own`,
          ]),
        );
        const port = yield* server.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        yield* fs.makeDirectory(stateDir(stateKey), { recursive: true });
        yield* fs.copyFile(`${stateDir(runnerFrom)}/run-t3.sh`, `${stateDir(stateKey)}/run-t3.sh`);
        yield* fs.copyFile(
          `${stateDir(runnerFrom)}/run-t3.sh`,
          `${stateDir(stateKey)}/active-runner.sh`,
        );
        const identity = yield* spawner.spawn(
          ChildProcess.make("ps", ["-p", String(server.pid), "-o", "lstart="], {
            env: { LC_ALL: "C", TZ: "UTC" },
          }),
        );
        const started = yield* identity.stdout.pipe(Stream.decodeText(), Stream.mkString);
        assert.equal(yield* identity.exitCode, 0);
        yield* fs.writeFileString(`${stateDir(stateKey)}/process-start`, started);
        yield* fs.writeFileString(`${stateDir(stateKey)}/pid`, `${server.pid}\n`);
        yield* fs.writeFileString(`${stateDir(stateKey)}/port`, `${Option.getOrThrow(port)}\n`);
        yield* fs.writeFileString(`${stateDir(stateKey)}/managed`, "managed\n");
        return {
          pid: Number(server.pid),
          port: Number(Option.getOrThrow(port)),
          exitCode: server.exitCode,
        };
      });
    return {
      fs,
      home,
      fakeServer,
      stateDir,
      readManagedPid,
      launch,
      launchScript,
      stop,
      startOwnServer,
    };
  });

  it.live("keeps managing its server after the connection's state key changes", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch } = yield* prepareLaunch;
      const launched = yield* launch("old-alias");
      assert.equal(launched.serverKind, "managed");
      const pid = yield* readManagedPid("old-alias");

      // Earlier launchers recorded the renamed key as external.
      yield* fs.makeDirectory(stateDir("new-alias"), { recursive: true });
      yield* fs.writeFileString(`${stateDir("new-alias")}/managed`, "external\n");
      assert.deepEqual(yield* launch("new-alias"), launched);
      assert.equal(yield* readManagedPid("new-alias"), pid);
      assert.isFalse(yield* fs.exists(`${stateDir("old-alias")}/managed`));
      assert.isTrue(isAlive(pid));

      // new-alias now holds the server's runner, so a different runner under
      // the next key is an update and replaces it.
      yield* fs.writeFileString(`${stateDir("new-alias")}/active-runner.sh`, "# previous runner\n");
      assert.equal((yield* launch("newer-alias")).serverKind, "managed");
      const replacementPid = yield* readManagedPid("newer-alias");
      assert.notEqual(replacementPid, pid);
      assert.isFalse(isAlive(pid));
      assert.isTrue(isAlive(replacementPid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("serializes two aliases claiming the same managed server", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch, launchScript, stop } = yield* prepareLaunch;
      const launched = yield* launch("old-alias");
      const pid = yield* readManagedPid("old-alias");
      const firstAtTransfer = yield* Deferred.make<void>();
      const secondProgress = yield* Deferred.make<"waiting" | "transferring">();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const script = yield* fs.readFileString(launchScript);
      // Pause at the transfer and report actual lock contention. This makes the
      // race reproducible without depending on subprocess scheduling.
      yield* fs.writeFileString(
        launchScript,
        script
          .replace(
            'if cmp -s "$PREVIOUS_STATE_DIR/active-runner.sh" "$RUNNER_FILE"; then',
            'printf "transferring\\n"; read -r release; if cmp -s "$PREVIOUS_STATE_DIR/active-runner.sh" "$RUNNER_FILE"; then',
          )
          .replace(
            '  if [ "$LOCK_WAIT_COUNT" -ge 200 ]; then',
            '  printf "waiting\\n"; if [ "$LOCK_WAIT_COUNT" -ge 200 ]; then',
          ),
      );
      const first = yield* launch("first-alias", {
        onLine: (line) =>
          line === "transferring"
            ? Deferred.succeed(firstAtTransfer, undefined).pipe(Effect.asVoid)
            : Effect.void,
        release: Deferred.await(releaseFirst),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstAtTransfer);
      const second = yield* launch("second-alias", {
        onLine: (line) =>
          line === "waiting" || line === "transferring"
            ? Deferred.succeed(secondProgress, line).pipe(Effect.asVoid)
            : Effect.void,
        release: Deferred.await(releaseSecond),
      }).pipe(Effect.forkScoped);
      assert.equal(yield* Deferred.await(secondProgress), "waiting");
      yield* Deferred.succeed(releaseFirst, undefined);
      assert.deepEqual(yield* Fiber.join(first), launched);
      yield* Deferred.succeed(releaseSecond, undefined);
      assert.deepEqual(yield* Fiber.join(second), launched);
      assert.equal(yield* readManagedPid("second-alias"), pid);
      assert.isFalse(yield* fs.exists(`${stateDir("first-alias")}/pid`));
      assert.isFalse(yield* fs.exists(`${stateDir("old-alias")}/pid`));
      yield* stop("old-alias");
      yield* stop("first-alias");
      assert.isTrue(isAlive(pid));
      yield* stop("second-alias");
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves one owner when transfer preparation is interrupted", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch, launchScript, stop } = yield* prepareLaunch;
      const launched = yield* launch("old-alias");
      const pid = yield* readManagedPid("old-alias");
      const script = yield* fs.readFileString(launchScript);
      yield* fs.writeFileString(
        launchScript,
        script.replace(
          '    cp "$PREVIOUS_STATE_DIR/process-start" "$PROCESS_START_FILE"',
          '    printf "interrupted\\n" >"$STATE_DIR/interrupted"; kill -TERM "$$"',
        ),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(launch("new-alias"))));
      assert.isTrue(yield* fs.exists(`${stateDir("new-alias")}/interrupted`));
      assert.isFalse(yield* fs.exists(`${stateDir("new-alias")}/managed`));
      assert.equal(yield* readManagedPid("old-alias"), pid);
      yield* stop("new-alias");
      assert.isTrue(isAlive(pid));
      yield* fs.writeFileString(launchScript, script);
      assert.deepEqual(yield* launch("new-alias"), launched);
      assert.equal(yield* readManagedPid("new-alias"), pid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["HUP", "PIPE"])("releases the ownership lock after %s", (signal) =>
    Effect.gen(function* () {
      const { fs, home, launch, launchScript } = yield* prepareLaunch;
      const script = yield* fs.readFileString(launchScript);
      yield* fs.writeFileString(
        launchScript,
        script.replace('mkdir -p "$STATE_DIR"', `kill -${signal} "$$"; mkdir -p "$STATE_DIR"`),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(launch("alias"))));
      assert.isFalse(yield* fs.exists(`${home}/.t3/ssh-launch/.ownership.lock`));
      yield* fs.writeFileString(launchScript, script);
      assert.equal((yield* launch("alias")).serverKind, "managed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not replace a PID left by an interrupted transfer without ownership", () =>
    Effect.gen(function* () {
      const { fs, home, stateDir, readManagedPid, launch } = yield* prepareLaunch;
      yield* launch("old-alias");
      const pid = yield* readManagedPid("old-alias");
      yield* fs.makeDirectory(stateDir("new-alias"));
      for (const file of ["pid", "port", "process-start", "active-runner.sh"]) {
        yield* fs.copyFile(`${stateDir("old-alias")}/${file}`, `${stateDir("new-alias")}/${file}`);
      }
      yield* fs.writeFileString(`${stateDir("new-alias")}/active-runner.sh`, "# previous runner\n");
      yield* fs.writeFileString(`${home}/.t3/userdata/server-runtime.json`, "invalid");
      yield* launch("new-alias");
      assert.isTrue(isAlive(pid));
      assert.equal(yield* readManagedPid("old-alias"), pid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reuses an adopted external port after its former managed process exits", () =>
    Effect.gen(function* () {
      const { fs, home, stateDir, readManagedPid, launch, startOwnServer } = yield* prepareLaunch;
      const external = yield* launch("old-alias");
      const pid = yield* readManagedPid("old-alias");
      const own = yield* startOwnServer("own-alias", "old-alias");
      yield* fs.remove(`${stateDir("old-alias")}/managed`);
      assert.deepEqual(yield* launch("own-alias"), {
        remotePort: external.remotePort,
        serverKind: "external",
      });
      yield* Effect.flip(own.exitCode);
      yield* fs.writeFileString(`${home}/.t3/userdata/server-runtime.json`, "invalid");
      assert.deepEqual(yield* launch("own-alias"), {
        remotePort: external.remotePort,
        serverKind: "external",
      });
      assert.isTrue(isAlive(pid));
      assert.isFalse(yield* fs.exists(`${stateDir("own-alias")}/process-start`));
      assert.isFalse(yield* fs.exists(`${stateDir("own-alias")}/active-runner.sh`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not take ownership from a stale record for a different process", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch } = yield* prepareLaunch;
      const launched = yield* launch("old-alias");
      const pid = yield* readManagedPid("old-alias");
      yield* fs.writeFileString(`${stateDir("old-alias")}/process-start`, "a previous process\n");
      assert.deepEqual(yield* launch("new-alias"), {
        remotePort: launched.remotePort,
        serverKind: "external",
      });
      assert.equal(yield* readManagedPid("old-alias"), pid);
      assert.isFalse(yield* fs.exists(`${stateDir("new-alias")}/pid`));
      assert.isTrue(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not stop a reused PID recorded under the current key", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch, stop } = yield* prepareLaunch;
      yield* launch("alias");
      const pid = yield* readManagedPid("alias");
      yield* fs.writeFileString(`${stateDir("alias")}/process-start`, "a previous process\n");
      yield* stop("alias");
      assert.isTrue(isAlive(pid));
      assert.isFalse(yield* fs.exists(`${stateDir("alias")}/pid`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps ownership when a server refuses to stop during replacement", () =>
    Effect.gen(function* () {
      const { fs, fakeServer, stateDir, readManagedPid, launch } = yield* prepareLaunch;
      yield* fs.writeFileString(fakeServer, `process.on("SIGTERM", () => {});\n${FAKE_SERVER}`);
      yield* launch("alias");
      const pid = yield* readManagedPid("alias");
      yield* fs.writeFileString(`${stateDir("alias")}/active-runner.sh`, "# previous runner\n");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(launch("alias"))));
      assert.equal(yield* readManagedPid("alias"), pid);
      assert.isTrue(isAlive(pid));
      assert.equal(yield* fs.readFileString(`${stateDir("alias")}/managed`), "managed\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("compares against the running runner after a prepared runner was overwritten", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch } = yield* prepareLaunch;
      yield* launch("alias");
      const pid = yield* readManagedPid("alias");
      // Pairing and a failed archive preparation can both overwrite run-t3.sh.
      // They do not change which runner started the live server.
      yield* fs.writeFileString(
        `${stateDir("alias")}/active-runner.sh`,
        "# previous live runner\n",
      );
      yield* launch("alias");
      assert.notEqual(yield* readManagedPid("alias"), pid);
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps legacy ownership records external when their process identity is unknown", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch } = yield* prepareLaunch;
      const launched = yield* launch("old-alias");
      const pid = yield* readManagedPid("old-alias");
      yield* fs.remove(`${stateDir("old-alias")}/process-start`, { force: true });
      assert.deepEqual(yield* launch("new-alias"), {
        remotePort: launched.remotePort,
        serverKind: "external",
      });
      assert.equal(yield* readManagedPid("old-alias"), pid);
      assert.isTrue(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps its own server while the other key's server does not answer", () =>
    Effect.gen(function* () {
      const { fs, home, stateDir, readManagedPid, launch, startOwnServer } = yield* prepareLaunch;
      yield* launch("old-alias");
      const otherPid = yield* readManagedPid("old-alias");
      const own = yield* startOwnServer("own-alias", "old-alias");

      yield* fs.writeFileString(`${home}/.t3/unready`, "");
      assert.deepEqual(yield* launch("own-alias"), { remotePort: own.port, serverKind: "managed" });
      assert.equal(yield* readManagedPid("own-alias"), own.pid);
      assert.equal(yield* readManagedPid("old-alias"), otherPid);

      // Once it answers, the takeover stops this key's own server.
      yield* fs.remove(`${home}/.t3/unready`);
      assert.equal((yield* launch("own-alias")).serverKind, "managed");
      yield* Effect.flip(own.exitCode);
      assert.equal(yield* readManagedPid("own-alias"), otherPid);
      assert.isFalse(yield* fs.exists(`${stateDir("old-alias")}/pid`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

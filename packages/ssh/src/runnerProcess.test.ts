import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@lathe/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeNet from "node:net";

import { remoteStateKey } from "./command.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteLatheRunnerScript,
  REMOTE_LAUNCH_ACTIONS,
} from "./tunnel.ts";

const Started = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  args: Schema.Array(Schema.String),
});
const decodeStarted = Schema.decodeUnknownSync(Schema.fromJsonString(Started));

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote runner process ownership",
  () => {
    it.live("keeps the server PID and graceful shutdown through the node-script runner", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-runner-" });
        const bin = path.join(fixture, "bin");
        const cliPath = path.join(fixture, "installed cli.mjs");
        yield* fs.makeDirectory(bin);
        yield* fs.symlink(process.execPath, path.join(bin, "node"));
        yield* fs.writeFileString(
          cliPath,
          `#!/usr/bin/env node
import * as net from "node:net";
const server = net.createServer((socket) => {
  socket.end();
  server.close();
});
process.on("SIGTERM", () => server.close(() => {
  process.stdout.write("graceful shutdown\\n");
}));
server.listen(Number(process.env.LATHE_TEST_PORT ?? 0), "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    port: server.address().port,
    args: process.argv.slice(2),
  }) + "\\n");
});
`,
        );
        yield* fs.chmod(cliPath, 0o700);

        const runServer = (port = 0) =>
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("/bin/sh", ["-s", "--", "serve", "a path with spaces"], {
                cwd: fixture,
                env: {
                  PATH: bin,
                  LATHE_TEST_PORT: String(port),
                },
                detached: false,
                stdin: Stream.make(
                  new TextEncoder().encode(
                    buildRemoteLatheRunnerScript({ nodeScriptPath: cliPath }),
                  ),
                ),
              }),
            );
            const ready = yield* Deferred.make<typeof Started.Type>();
            const stdout: string[] = [];
            const output = yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.gen(function* () {
                  stdout.push(line);
                  if (stdout.length === 1) {
                    yield* Deferred.succeed(ready, decodeStarted(line));
                  }
                }),
              ),
              Effect.forkScoped,
            );
            const stderr = yield* child.stderr.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.forkScoped,
            );
            const receipt = yield* Effect.raceFirst(
              Deferred.await(ready),
              Fiber.join(output).pipe(
                Effect.flatMap(() => Fiber.join(stderr)),
                Effect.flatMap((message) =>
                  Effect.die(new Error(`Runner exited before listening: ${message}`)),
                ),
              ),
            );
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (yield* child.isRunning) {
                  yield* Effect.callback<void>((resume) => {
                    const connection = NodeNet.connect(receipt.port, "127.0.0.1");
                    connection.on("error", () => undefined);
                    connection.once("close", () => resume(Effect.void));
                    return Effect.sync(() => connection.destroy());
                  });
                  yield* child.exitCode;
                }
              }).pipe(Effect.orDie),
            );
            assert.equal(receipt.pid, child.pid);
            assert.deepEqual(receipt.args, ["serve", "a path with spaces"]);
            yield* child.kill({ killSignal: "SIGTERM" });
            assert.equal(yield* child.exitCode, 0);
            yield* Fiber.join(output);
            assert.include(stdout, "graceful shutdown");
            return receipt.port;
          }).pipe(Effect.scoped);

        const port = yield* runServer();
        assert.equal(yield* runServer(port), port);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote stop process ownership",
  () => {
    it.live.each(["graceful", "timeout", "external"] as const)(
      "confirms the stop result for a %s server",
      (mode) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-stop-" });
          const signalPath = path.join(fixture, "signals");
          const child = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `import * as fs from "node:fs";
import * as net from "node:net";
const server = net.createServer((socket) => socket.end());
let signals = 0;
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[2], String(++signals));
  if (process.argv[1] !== "timeout" || signals > 1) server.close();
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ pid: process.pid, port: server.address().port, args: [] }) + "\\n");
});
`,
                mode,
                signalPath,
                // The stop script only signals a process that looks like a managed server.
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
              ],
              { cwd: fixture, detached: false },
            ),
          );
          yield* Effect.addFinalizer(() =>
            child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore),
          );
          const started = decodeStarted(
            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.take(1),
              Stream.mkString,
            ),
          );
          assert.equal(started.pid, child.pid);
          const savedState = {
            pid: `${child.pid}\n`,
            port: `${started.port}\n`,
            managed: mode === "external" ? "external\n" : "managed\n",
          };
          for (const [name, contents] of Object.entries(savedState)) {
            yield* fs.writeFileString(path.join(fixture, name), contents);
          }
          const script = buildRemoteStopScript(
            yield* remoteStateKey({
              alias: "fixture",
              hostname: "fixture",
              username: null,
              port: null,
            }),
          );
          // The timeout case waits out the whole grace, so shorten it to keep the test quick.
          const isolatedScript = script
            .replace(/^STATE_DIR=.*$/mu, 'STATE_DIR="$LATHE_TEST_STATE_DIR"')
            .replace(/^STOP_WAIT_SECONDS=15$/mu, "STOP_WAIT_SECONDS=2");
          assert.include(isolatedScript, 'STATE_DIR="$LATHE_TEST_STATE_DIR"');
          assert.include(isolatedScript, "STOP_WAIT_SECONDS=2\n");
          const runStop = Effect.fn("test.remoteStop")(function* () {
            const stop = yield* spawner.spawn(
              ChildProcess.make("/bin/sh", ["-s"], {
                cwd: fixture,
                env: { LATHE_TEST_STATE_DIR: fixture },
                stdin: Stream.make(new TextEncoder().encode(isolatedScript)),
              }),
            );
            return yield* Effect.all(
              {
                stdout: stop.stdout.pipe(Stream.decodeText(), Stream.mkString),
                stderr: stop.stderr.pipe(Stream.decodeText(), Stream.mkString),
                exitCode: stop.exitCode,
              },
              { concurrency: "unbounded" },
            );
          }, Effect.scoped);
          let result = yield* runStop();
          if (mode !== "graceful") {
            assert.isTrue(yield* child.isRunning);
            yield* Effect.callback<void, Error>((resume) => {
              const connection = NodeNet.connect(started.port, "127.0.0.1");
              connection.once("error", (error) => resume(Effect.fail(error)));
              connection.once("close", () => resume(Effect.void));
              return Effect.sync(() => connection.destroy());
            });
          }
          if (mode === "timeout") {
            assert.equal(result.exitCode, 1);
            assert.equal(result.stdout, "");
            assert.include(result.stderr, "did not stop within 2 seconds");
            assert.equal(yield* fs.readFileString(signalPath), "1");
            for (const [name, contents] of Object.entries(savedState)) {
              assert.equal(yield* fs.readFileString(path.join(fixture, name)), contents);
            }
            result = yield* runStop();
          }
          assert.equal(result.exitCode, 0);
          assert.equal(result.stdout, '{"stopped":true}\n');
          assert.equal(result.stderr, "");
          for (const name of Object.keys(savedState)) {
            assert.isFalse(yield* fs.exists(path.join(fixture, name)));
          }
          if (mode === "external") {
            assert.isFalse(yield* fs.exists(signalPath));
          } else {
            assert.equal(yield* child.exitCode, 0);
            assert.equal(yield* fs.readFileString(signalPath), mode === "timeout" ? "2" : "1");
          }
        }).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Effect.scoped,
        ),
    );
  },
);

// The launch script is generated shell, so reuse is proven by running it with
// real sh against a fake node-script server. HOME and both state directories
// point at the fixture; nothing touches the developer's Lathe home.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote launch server reuse",
  () => {
    const LaunchResult = Schema.Struct({
      remotePort: Schema.Number,
      serverKind: Schema.Literals(["external", "managed"]),
      action: Schema.Literals(REMOTE_LAUNCH_ACTIONS),
    });
    const decodeLaunchResult = Schema.decodeUnknownSync(Schema.fromJsonString(LaunchResult));
    const ServerEvent = Schema.Struct({
      pid: Schema.Number,
      event: Schema.Literals(["started", "listening", "request", "sigterm"]),
      port: Schema.optional(Schema.Number),
    });
    const decodeServerEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ServerEvent));

    // Serves 200 on `/`, writes the runtime file the real server writes under
    // its base dir, and logs every event so a test can see restarts and kills.
    // The behavior file read at start makes it fail, stall until SIGUSR1, or
    // ignore its first SIGTERM, like a server migrating or reconciling.
    const FAKE_SERVER = `import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
const log = (entry) =>
  fs.appendFileSync(process.env.LATHE_TEST_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === "auth") {
  process.stdout.write(JSON.stringify({ credential: "fixture" }) + "\\n");
  process.exit(0);
}
const behavior = fs.existsSync(process.env.LATHE_TEST_BEHAVIOR)
  ? JSON.parse(fs.readFileSync(process.env.LATHE_TEST_BEHAVIOR, "utf8"))
  : {};
log({ event: "started" });
if (behavior.start === "exit") {
  process.stderr.write("fixture server refused to start\\n");
  process.exit(1);
}
const server = http.createServer((_request, response) => {
  log({ event: "request" });
  response.end("ok");
});
let ignoredSigterm = false;
process.on("SIGTERM", () => {
  log({ event: "sigterm" });
  if (behavior.stop === "ignore-first" && !ignoredSigterm) {
    ignoredSigterm = true;
    return;
  }
  process.exit(0);
});
const listen = () => server.listen(Number(option("--port")), "127.0.0.1", () => {
  const port = server.address().port;
  const userdata = path.join(option("--base-dir"), "userdata");
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(
    path.join(userdata, "server-runtime.json"),
    JSON.stringify({ pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
  );
  log({ event: "listening", port });
  process.stdout.write("listening\\n");
});
if (behavior.start === "hold") {
  // Signal handlers alone do not keep the event loop alive.
  const stall = setInterval(() => {}, 1 << 30);
  process.once("SIGUSR2", () => {
    clearInterval(stall);
    listen();
  });
} else {
  listen();
}
`;

    const freeLoopbackPort = Effect.callback<number, Error>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resume(Effect.succeed(port)));
      });
    });

    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const makeFixture = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-launch-" });
      const bin = path.join(fixture, "bin");
      const cliPath = path.join(fixture, "fake server.mjs");
      const logPath = path.join(fixture, "events.log");
      const behaviorPath = path.join(fixture, "behavior.json");
      const serverHome = path.join(fixture, "home", ".lathe");
      const stateDir = path.join(serverHome, "ssh-launch", "fixture");
      yield* fs.makeDirectory(bin);
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.symlink(process.execPath, path.join(bin, "node"));
      yield* fs.writeFileString(cliPath, FAKE_SERVER);
      yield* fs.writeFileString(logPath, "");
      const env = {
        HOME: path.join(fixture, "home"),
        PATH: `${bin}:/usr/bin:/bin`,
        LATHE_TEST_LOG: logPath,
        LATHE_TEST_BEHAVIOR: behaviorPath,
        LATHE_TEST_STATE_DIR: stateDir,
        LATHE_TEST_SERVER_HOME: serverHome,
      };

      const events = Effect.map(fs.readFileString(logPath), (text) =>
        text
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => decodeServerEvent(line)),
      );
      // Launched servers outlive the launch shell, so stop each one the fake logged.
      yield* Effect.addFinalizer(() =>
        events.pipe(
          Effect.map((entries) => {
            for (const entry of entries) {
              if (entry.event === "started" && isAlive(entry.pid)) {
                process.kill(entry.pid, "SIGKILL");
              }
            }
          }),
          Effect.ignore,
        ),
      );

      const isolate = (script: string) => {
        const isolated = script
          .replace(/^STATE_DIR=.*$/mu, 'STATE_DIR="$LATHE_TEST_STATE_DIR"')
          .replace(/^DEFAULT_SERVER_HOME=.*$/mu, 'DEFAULT_SERVER_HOME="$LATHE_TEST_SERVER_HOME"');
        assert.include(isolated, 'STATE_DIR="$LATHE_TEST_STATE_DIR"');
        assert.include(isolated, 'DEFAULT_SERVER_HOME="$LATHE_TEST_SERVER_HOME"');
        return isolated;
      };

      const runScript = Effect.fn("test.remoteScript")(function* (
        script: string,
        args: ReadonlyArray<string>,
      ) {
        const child = yield* spawner.spawn(
          ChildProcess.make("/bin/sh", ["-s", "--", ...args], {
            cwd: fixture,
            env,
            // The launched server must outlive this shell, as it does over SSH.
            detached: false,
            stdin: Stream.make(new TextEncoder().encode(isolate(script))),
          }),
        );
        return yield* Effect.all(
          {
            stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            exitCode: child.exitCode,
          },
          { concurrency: "unbounded" },
        );
      }, Effect.scoped);

      // Shortens the launch script's waits, which default to production values.
      const launchScript = (timing: { readyTimeoutMs?: number; restartWaitSeconds?: number }) => {
        let script = buildRemoteLaunchScript({ nodeScriptPath: cliPath });
        for (const [name, value] of [
          ["READY_TIMEOUT_MS", timing.readyTimeoutMs],
          ["RESTART_WAIT_SECONDS", timing.restartWaitSeconds],
        ] as const) {
          if (value === undefined) continue;
          script = script.replace(new RegExp(`^${name}=\\d+$`, "mu"), `${name}=${value}`);
          assert.include(script, `\n${name}=${value}\n`);
        }
        return runScript(script, ["fixture"]);
      };

      const launch = Effect.gen(function* () {
        const result = yield* launchScript({});
        assert.equal(result.exitCode, 0, result.stderr);
        return decodeLaunchResult(result.stdout.trim());
      });

      const setBehavior = (behavior: { start?: "exit" | "hold"; stop?: "ignore-first" }) =>
        fs.writeFileString(behaviorPath, JSON.stringify(behavior));

      const readState = (name: string) =>
        fs.readFileString(path.join(stateDir, name)).pipe(
          Effect.map((text) => text.trim()),
          Effect.orElseSucceed(() => null),
        );

      // An unowned server on the same base dir, as if the user ran `serve` themselves.
      const startExternalServer = Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [cliPath, "serve", "--host", "127.0.0.1", "--port", "0", "--base-dir", serverHome],
            { cwd: fixture, env, detached: false },
          ),
        );
        yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore));
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(1),
          Stream.runDrain,
        );
        return Number(child.pid);
      });

      // Pin the cold start to a free port instead of the product default.
      yield* fs.writeFileString(path.join(stateDir, "port"), `${yield* freeLoopbackPort}\n`);
      return {
        fs,
        path,
        cliPath,
        serverHome,
        stateDir,
        events,
        launch,
        launchScript,
        setBehavior,
        readState,
        runScript,
        startExternalServer,
      };
    });

    it.live(
      "reuses its own managed server even though that server wrote the default runtime file",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture;
          const first = yield* fixture.launch;
          assert.equal(first.serverKind, "managed");
          assert.equal(first.action, "started");
          const managedPid = Number(yield* fixture.readState("pid"));
          const runtime = yield* fixture.fs.readFileString(
            fixture.path.join(fixture.serverHome, "userdata", "server-runtime.json"),
          );
          assert.include(runtime, `"pid":${managedPid}`);
          assert.include(runtime, `"port":${first.remotePort}`);

          const second = yield* fixture.launch;

          assert.deepEqual(second, {
            remotePort: first.remotePort,
            serverKind: "managed",
            action: "reused",
          });
          assert.equal(yield* fixture.readState("pid"), String(managedPid));
          assert.equal(yield* fixture.readState("managed"), "managed");
          assert.isTrue(isAlive(managedPid));
          const events = yield* fixture.events;
          assert.isFalse(events.some((entry) => entry.event === "sigterm"));
          assert.equal(events.filter((entry) => entry.event === "listening").length, 1);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("adopts an external server named by the default runtime file and stops its own", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const first = yield* fixture.launch;
        const managedPid = Number(yield* fixture.readState("pid"));
        const externalPid = yield* fixture.startExternalServer;
        const external = (yield* fixture.events).find(
          (entry) => entry.pid === externalPid && entry.event === "listening",
        );
        assert.isDefined(external);

        const second = yield* fixture.launch;

        assert.deepEqual(second, {
          remotePort: external?.port ?? -1,
          serverKind: "external",
          action: "replaced-by-external",
        });
        assert.notEqual(second.remotePort, first.remotePort);
        assert.isNull(yield* fixture.readState("pid"));
        assert.equal(yield* fixture.readState("managed"), "external");
        assert.isFalse(isAlive(managedPid));
        assert.isTrue(isAlive(externalPid));
        assert.deepEqual(
          (yield* fixture.events)
            .filter((entry) => entry.event === "sigterm")
            .map((entry) => entry.pid),
          [managedPid],
        );

        const third = yield* fixture.launch;

        assert.deepEqual(third, { ...second, action: "reused-external" });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("adopts an external server on a first launch without starting its own", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const externalPid = yield* fixture.startExternalServer;

        const first = yield* fixture.launch;

        assert.equal(first.serverKind, "external");
        assert.equal(first.action, "adopted-external");
        assert.isTrue(isAlive(externalPid));
        const listening = (yield* fixture.events).filter((entry) => entry.event === "listening");
        assert.deepEqual(
          listening.map((entry) => entry.pid),
          [externalPid],
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("restarts its own managed server when the runner changed", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* fixture.launch;
        const firstPid = Number(yield* fixture.readState("pid"));
        const runnerPath = fixture.path.join(fixture.stateDir, "run-lathe.sh");
        yield* fixture.fs.writeFileString(
          runnerPath,
          `${yield* fixture.fs.readFileString(runnerPath)}\n# older runner\n`,
        );

        const second = yield* fixture.launch;

        assert.equal(second.serverKind, "managed");
        assert.equal(second.action, "restarted-runner-changed");
        const secondPid = Number(yield* fixture.readState("pid"));
        assert.notEqual(secondPid, firstPid);
        assert.isFalse(isAlive(firstPid));
        const events = yield* fixture.events;
        assert.deepEqual(
          events.filter((entry) => entry.event === "sigterm").map((entry) => entry.pid),
          [firstPid],
        );
        const listening = events.filter((entry) => entry.event === "listening");
        assert.deepEqual(
          listening.map((entry) => entry.pid),
          [firstPid, secondPid],
        );
        assert.equal(second.remotePort, listening[1]?.port);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    // A large database can take minutes to migrate. Killing it on the deadline
    // threw that work away and left it holding the home for the next attempt.
    it.live("leaves a slow-starting server running and reuses it on the next launch", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* fixture.setBehavior({ start: "hold" });

        const first = yield* fixture.launchScript({ readyTimeoutMs: 1_500 });

        assert.equal(first.exitCode, 1);
        assert.include(first.stderr, "still starting");
        const pid = Number(yield* fixture.readState("pid"));
        assert.isTrue(isAlive(pid));
        assert.equal(yield* fixture.readState("managed"), "managed");
        process.kill(pid, "SIGUSR2");

        const second = yield* fixture.launch;

        assert.equal(second.action, "reused");
        assert.equal(yield* fixture.readState("pid"), String(pid));
        const events = yield* fixture.events;
        assert.isFalse(events.some((entry) => entry.event === "sigterm"));
        assert.deepEqual(
          events.filter((entry) => entry.event === "started").map((entry) => entry.pid),
          [pid],
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("fails as soon as the started server exits instead of waiting out readiness", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* fixture.setBehavior({ start: "exit" });

        const result = yield* fixture.launchScript({});

        assert.equal(result.exitCode, 1);
        assert.include(result.stderr, "exited before it became ready");
        assert.include(result.stderr, "fixture server refused to start");
        assert.isNull(yield* fixture.readState("pid"));
        assert.isNull(yield* fixture.readState("port"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    // The replacement would boot into the old server's ownership lock and exit.
    it.live("starts no replacement while the old server is still stopping, and retries", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* fixture.setBehavior({ stop: "ignore-first" });
        yield* fixture.launch;
        const oldPid = Number(yield* fixture.readState("pid"));
        const runnerPath = fixture.path.join(fixture.stateDir, "run-lathe.sh");
        yield* fixture.fs.writeFileString(
          runnerPath,
          `${yield* fixture.fs.readFileString(runnerPath)}\n# older runner\n`,
        );

        const blocked = yield* fixture.launchScript({ restartWaitSeconds: 1 });

        assert.equal(blocked.exitCode, 1);
        assert.include(blocked.stderr, "still shutting down");
        assert.isTrue(isAlive(oldPid));
        assert.equal(yield* fixture.readState("pid"), String(oldPid));
        const startedBefore = (yield* fixture.events).filter((entry) => entry.event === "started");
        assert.deepEqual(
          startedBefore.map((entry) => entry.pid),
          [oldPid],
        );

        const retried = yield* fixture.launch;

        assert.equal(retried.action, "restarted-runner-changed");
        assert.isFalse(isAlive(oldPid));
        const newPid = Number(yield* fixture.readState("pid"));
        assert.notEqual(newPid, oldPid);
        assert.deepEqual(
          (yield* fixture.events).filter((entry) => entry.event === "sigterm").map((e) => e.pid),
          [oldPid, oldPid],
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("pairing replaces the runner atomically and leaves an identical one alone", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const runnerPath = fixture.path.join(fixture.stateDir, "run-lathe.sh");
        const heldPath = fixture.path.join(fixture.stateDir, "held-runner");
        const pair = Effect.gen(function* () {
          const result = yield* fixture.runScript(
            buildRemotePairingScript("fixture", { nodeScriptPath: fixture.cliPath }),
            [],
          );
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(result.stdout, '{"credential":"fixture"}\n');
        });
        // A launch may be executing the old runner; it must never see a partial rewrite.
        yield* fixture.fs.writeFileString(runnerPath, "#!/bin/sh\nexit 1\n");
        yield* fixture.fs.link(runnerPath, heldPath);

        yield* pair;

        assert.equal(yield* fixture.fs.readFileString(heldPath), "#!/bin/sh\nexit 1\n");
        const replaced = yield* fixture.fs.stat(runnerPath);
        assert.notDeepEqual(replaced.ino, (yield* fixture.fs.stat(heldPath)).ino);
        assert.equal(replaced.mode & 0o777, 0o700);
        // No temporary runner is left behind.
        assert.deepEqual((yield* fixture.fs.readDirectory(fixture.stateDir)).toSorted(), [
          "held-runner",
          "port",
          "run-lathe.sh",
        ]);

        yield* pair;

        assert.deepEqual((yield* fixture.fs.stat(runnerPath)).ino, replaced.ino);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

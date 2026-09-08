import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeNet from "node:net";

import { buildRemoteStopScript, buildRemoteT3RunnerScript } from "./tunnel.ts";

const Started = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  args: Schema.Array(Schema.String),
});
const decodeStarted = Schema.decodeUnknownSync(Schema.fromJsonString(Started));

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "remote runner process ownership",
  () => {
    it.live.each(["npx", "npm"] as const)(
      "keeps the server PID and graceful shutdown through the %s fallback",
      (packageManager) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-" });
          const bin = path.join(fixture, "bin");
          const cliPath = path.join(fixture, "installed cli.mjs");
          const callsPath = path.join(fixture, "package-manager-calls.jsonl");
          const packageSpec = "t3@0.0.35";
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
server.listen(Number(process.env.T3_TEST_PORT ?? 0), "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    port: server.address().port,
    args: process.argv.slice(2),
  }) + "\\n");
});
`,
          );
          yield* fs.chmod(cliPath, 0o700);
          yield* fs.writeFileString(
            path.join(bin, packageManager),
            `#!/usr/bin/env node
const fs = require("node:fs");
const childProcess = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.T3_TEST_CALLS, JSON.stringify(args) + "\\n");
if (args.includes("--package")) {
  process.stdout.write(process.env.T3_TEST_CLI + "\\n");
} else {
  const child = childProcess.spawn(process.execPath, [process.env.T3_TEST_CLI, ...args], { stdio: "inherit" });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
`,
          );
          yield* fs.chmod(path.join(bin, packageManager), 0o700);

          const runServer = (port = 0) =>
            Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make("/bin/sh", ["-s", "--", "serve", "a path with spaces"], {
                  cwd: fixture,
                  env: {
                    PATH: bin,
                    T3_TEST_CLI: cliPath,
                    T3_TEST_CALLS: callsPath,
                    T3_TEST_PORT: String(port),
                  },
                  detached: false,
                  stdin: Stream.make(
                    new TextEncoder().encode(buildRemoteT3RunnerScript({ packageSpec })),
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
              // A failed PID assertion must still close the owned fixture server, including an npm child.
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
          const calls = (yield* fs.readFileString(callsPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const expectedCall = [
            ...(packageManager === "npm" ? ["exec"] : []),
            "--yes",
            "--package",
            packageSpec,
            "--",
            "sh",
            "-c",
            "command -v t3",
          ];
          assert.deepEqual(calls, [expectedCall, expectedCall]);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "remote stop process ownership",
  () => {
    it.live.each(["graceful", "timeout", "external"] as const)(
      "confirms the stop result for a %s server",
      (mode) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stop-" });
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
              ],
              { cwd: fixture, detached: false },
            ),
          );
          // A failed assertion must still stop this captured fixture process.
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
          const script = buildRemoteStopScript({
            alias: "fixture",
            hostname: "fixture",
            username: null,
            port: null,
          });
          // Redirect only the state directory. Never use the developer's SSH state.
          const isolatedScript = script.replace(
            /^STATE_DIR=.*$/mu,
            'STATE_DIR="$T3_TEST_STATE_DIR"',
          );
          assert.notEqual(isolatedScript, script);
          const runStop = Effect.fn("test.remoteStop")(function* () {
            const stop = yield* spawner.spawn(
              ChildProcess.make("/bin/sh", ["-s"], {
                cwd: fixture,
                env: { T3_TEST_STATE_DIR: fixture },
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
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "remote runner install diagnostics",
  () => {
    const decodeArguments = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    );
    const cases = (["npx", "npm"] as const).flatMap((packageManager) =>
      (
        [
          "etarget",
          "network",
          "empty-success",
          "success",
          "failed-with-path",
          "existing-cli",
          "node-override",
        ] as const
      ).map((mode) => ({ packageManager, mode })),
    );

    it.live.each(cases)("handles $packageManager/$mode", ({ packageManager, mode }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-install-" });
        const bin = path.join(fixture, "bin");
        const cliPath = path.join(fixture, "installed cli.mjs");
        const callsPath = path.join(fixture, "installer-calls.jsonl");
        const packageSpec = "t3@0.0.39-nightly.20260905.1286";
        const args = ["serve", "a path with spaces"];
        yield* fs.makeDirectory(bin);
        yield* fs.symlink(process.execPath, path.join(bin, "node"));
        yield* fs.writeFileString(
          cliPath,
          `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
`,
        );
        yield* fs.chmod(cliPath, 0o700);
        yield* fs.writeFileString(callsPath, "");
        yield* fs.writeFileString(
          path.join(bin, packageManager),
          `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.T3_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = process.env.T3_TEST_MODE;
if (mode === "success" || mode === "failed-with-path") {
  process.stdout.write(process.env.T3_TEST_CLI + "\\n");
}
if (mode === "etarget" || mode === "failed-with-path") {
  process.stderr.write("npm error code ETARGET\\nnpm error notarget No matching version found.\\n");
  process.exitCode = 42;
} else if (mode === "network") {
  process.stderr.write("npm error code ENETUNREACH\\n");
  process.exitCode = 43;
}
`,
        );
        yield* fs.chmod(path.join(bin, packageManager), 0o700);
        if (mode === "existing-cli") yield* fs.symlink(cliPath, path.join(bin, "t3"));

        const child = yield* spawner.spawn(
          ChildProcess.make("/bin/sh", ["-s", "--", ...args], {
            cwd: fixture,
            extendEnv: false,
            env: {
              PATH: bin,
              T3_TEST_MODE: mode,
              T3_TEST_CLI: cliPath,
              T3_TEST_CALLS: callsPath,
            },
            stdin: Stream.make(
              new TextEncoder().encode(
                buildRemoteT3RunnerScript({
                  packageSpec,
                  ...(mode === "node-override" ? { nodeScriptPath: cliPath } : {}),
                }),
              ),
            ),
          }),
        );
        const { stdout, stderr, exitCode } = yield* Effect.all(
          {
            stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            exitCode: child.exitCode,
          },
          { concurrency: "unbounded" },
        );
        const installFailed =
          mode === "etarget" || mode === "network" || mode === "failed-with-path";
        const missingExecutable = mode === "empty-success";
        assert.equal(exitCode, installFailed || missingExecutable ? 1 : 0);
        if (installFailed || missingExecutable) {
          assert.equal(stdout, "");
        } else {
          assert.deepEqual(decodeArguments(stdout), args);
        }
        if (installFailed) {
          const npmError = mode === "network" ? "ENETUNREACH" : "ETARGET";
          assert.include(stderr, `npm error code ${npmError}\n`);
          assert.include(stderr, `Remote host could not install ${packageSpec}.`);
          assert.notInclude(stderr, "Remote host installed");
          assert.notInclude(stderr, "Install a C toolchain");
        } else if (missingExecutable) {
          assert.include(stderr, `Remote host installed ${packageSpec}`);
          assert.include(stderr, "npm produced no t3 executable");
          assert.include(stderr, "Install a C toolchain");
        } else {
          assert.equal(stderr, "");
        }
        const expectedCall = [
          ...(packageManager === "npm" ? ["exec"] : []),
          "--yes",
          "--package",
          packageSpec,
          "--",
          "sh",
          "-c",
          "command -v t3",
        ];
        const usesInstaller = mode !== "existing-cli" && mode !== "node-override";
        const calls = yield* fs.readFileString(callsPath);
        if (usesInstaller) {
          assert.deepEqual(
            calls
              .trim()
              .split("\n")
              .map((line) => decodeArguments(line)),
            [expectedCall],
          );
        } else {
          assert.equal(calls, "");
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

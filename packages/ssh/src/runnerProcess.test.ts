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

import { buildRemoteT3RunnerScript } from "./tunnel.ts";

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

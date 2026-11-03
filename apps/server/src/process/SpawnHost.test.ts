// @effect-diagnostics nodeBuiltinImport:off - the regression intercepts the native spawn boundary and inspects IPC sockets.
// oxlint-disable-next-line t3code/namespace-node-imports -- Mutating the CJS export is necessary to intercept the native ESM binding.
import NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import type * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as SpawnHost from "./SpawnHost.ts";

const layer = SpawnHost.layerHost(process.execPath, [
  new URL("../bin.ts", import.meta.url).pathname,
  "__spawn-host",
]).pipe(Layer.provide(NodeServices.layer));
const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

// quarantine: #30183 Platform coverage: this layer is installed only on Linux.
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("SpawnHost", () => {
  it.live("starts commands without calling native spawn on the server thread", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const nativeSpawn = NodeChildProcess.spawn;
      const helpers: NodeChildProcess.ChildProcess[] = [];
      using _spawn = vi
        .spyOn(NodeChildProcess, "spawn")
        .mockImplementation((command, args, options) => {
          if (command === "/bin/echo") throw new Error("Native spawn blocked the server thread");
          const helper = nativeSpawn(command, args, options);
          helpers.push(helper);
          return helper;
        });
      using _restore = {
        [Symbol.dispose]() {
          _spawn.mockRestore();
          NodeModule.syncBuiltinESMExports();
        },
      };
      NodeModule.syncBuiltinESMExports();
      const child = yield* spawner.spawn(ChildProcess.make("/bin/echo", ["responsive"]));
      expect(yield* text(child.stdout)).toBe("responsive\n");
      expect(yield* child.exitCode).toBe(0);
      for (let i = 0; i < 2; i++) {
        yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", "process.stdin.resume()"]));
      }
      expect(helpers).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("lets another command finish while one host is blocked inside spawn", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<NodeChildProcess.ChildProcess>();
      const nativeSpawn = NodeChildProcess.spawn;
      using _spawn = vi
        .spyOn(NodeChildProcess, "spawn")
        .mockImplementation((command, args, options) => {
          const host = nativeSpawn(command, args, {
            ...options,
            stdio: ["inherit", "inherit", "inherit", "ipc", "pipe"],
          });
          Deferred.doneUnsafe(spawned, Exit.succeed(host));
          return host;
        });
      using _restore = {
        [Symbol.dispose]() {
          _spawn.mockRestore();
          NodeModule.syncBuiltinESMExports();
        },
      };
      NodeModule.syncBuiltinESMExports();
      const fixtureLayer = SpawnHost.layerHost(process.execPath, [
        new URL("./spawnHost.test-fixture.ts", import.meta.url).pathname,
      ]).pipe(Layer.provide(NodeServices.layer));
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const blocked = yield* spawner
          .spawn(ChildProcess.make("/t3-blocked-spawn"))
          .pipe(Effect.forkChild);
        const host = yield* Deferred.await(spawned);
        const gate = host.stdio[4] as NodeStream.Duplex;
        yield* Effect.promise(
          () => new Promise<void>((resolve) => gate.once("data", () => resolve())),
        );
        yield* Effect.gen(function* () {
          const healthy = yield* spawner.spawn(
            ChildProcess.make("/bin/echo", ["still responding"]),
          );
          expect(yield* text(healthy.stdout)).toBe("still responding\n");
          expect(yield* healthy.exitCode).toBe(0);
          expect(host.exitCode).toBeNull();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              gate.write("x");
            }),
          ),
        );
        const child = yield* Fiber.join(blocked);
        expect(yield* child.exitCode).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(fixtureLayer));
    }),
  );

  it.live("preserves stdin, fast output, env, cwd, literal args and additional descriptors", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const literal = "quote' \" $HOME; * &";
      const script = `
        const fs = require('node:fs');
        const input = fs.readFileSync(0, 'utf8');
        fs.writeSync(1, JSON.stringify([input, process.cwd(), process.env.SPAWN_HOST_TEST, process.argv[1]]) + '\\n');
        fs.writeSync(1, 'a'.repeat(1024 * 1024));
        fs.writeSync(2, 'b'.repeat(1024 * 1024));
        fs.writeSync(3, 'fd3:' + fs.readFileSync(4, 'utf8'));
      `;
      for (let i = 0; i < 3; i++) {
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", script, literal], {
            cwd: "/tmp",
            env: { SPAWN_HOST_TEST: "inherited value" },
            stdin: Stream.encodeText(Stream.make("stdin value")),
            additionalFds: {
              fd3: { type: "output" },
              fd4: { type: "input", stream: Stream.encodeText(Stream.make("fd4 value")) },
            },
          }),
        );
        const [stdout, stderr, fd3, code] = yield* Effect.all(
          [text(child.stdout), text(child.stderr), text(child.getOutputFd(3)), child.exitCode],
          { concurrency: "unbounded" },
        );
        expect(stdout).toBe(
          JSON.stringify(["stdin value", "/tmp", "inherited value", literal]) +
            "\n" +
            "a".repeat(1024 * 1024),
        );
        expect(stderr).toBe("b".repeat(1024 * 1024));
        expect(fd3).toBe("fd3:fd4 value");
        expect(code).toBe(0);
      }
      const pipeline = ChildProcess.make("/bin/echo", ["piped"]).pipe(
        ChildProcess.pipeTo(ChildProcess.make("/usr/bin/tr", ["a-z", "A-Z"])),
      );
      const child = yield* spawner.spawn(pipeline);
      expect(yield* text(child.stdout)).toBe("PIPED\n");
      expect(yield* child.exitCode).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("retains launch errors and exit codes, and can reuse a host after either", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const result = yield* spawner
        .spawn(ChildProcess.make("/t3-missing-command-30183"))
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("NotFound");
      const invalid = yield* spawner
        .spawn(ChildProcess.make("/bin/true", [], { cwd: "/dev/null" }))
        .pipe(Effect.result);
      expect(Result.isFailure(invalid)).toBe(true);
      const fdCounts: number[] = [];
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) {
          for (let i = 0; i < 12; i++) {
            for (const command of ["/t3-missing-command-30183", "/dev/null"]) {
              expect(
                Result.isFailure(
                  yield* spawner.spawn(ChildProcess.make(command)).pipe(Effect.result),
                ),
              ).toBe(true);
            }
          }
        }
        const probe = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            "process.stdout.write(String(require('node:fs').readdirSync('/proc/' + process.ppid + '/fd').length))",
          ]),
        );
        fdCounts.push(Number(yield* text(probe.stdout)));
        expect(yield* probe.exitCode).toBe(0);
      }
      expect(fdCounts[1]).toBe(fdCounts[0]);
      const child = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", "exit 23"]));
      expect(yield* child.exitCode).toBe(23);
      const healthy = yield* spawner.spawn(ChildProcess.make("/bin/true"));
      expect(yield* healthy.exitCode).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("kills a hosted process group and reports the signalled exit", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const detached of [true, false]) {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [
              "-e",
              "process.on('SIGTERM', () => {});process.stdout.write(String(process.pid));process.stdin.resume()",
            ],
            { detached },
          ),
        );
        const pid = yield* child.stdout.pipe(Stream.take(1), text);
        expect(Number(pid)).toBe(child.pid);
        yield* child.kill({ forceKillAfter: "0 millis" });
        expect(yield* child.isRunning).toBe(false);
        expect(Result.isFailure(yield* child.exitCode.pipe(Effect.result))).toBe(true);
      }
      const started = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const running = yield* Effect.gen(function* () {
        const scoped = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "process.stdin.resume()"]),
        );
        yield* Deferred.succeed(started, scoped);
        return yield* Effect.never;
      }).pipe(Effect.scoped, Effect.forkChild);
      const scoped = yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(yield* scoped.isRunning).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "fails a command when its launcher dies and starts the next command in a fresh host",
    () =>
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<NodeChildProcess.ChildProcess>();
        const nativeSpawn = NodeChildProcess.spawn;
        using _spawn = vi
          .spyOn(NodeChildProcess, "spawn")
          .mockImplementation((command, args, options) => {
            const host = nativeSpawn(command, args, options);
            Deferred.doneUnsafe(spawned, Exit.succeed(host));
            return host;
          });
        using _restore = {
          [Symbol.dispose]() {
            _spawn.mockRestore();
            NodeModule.syncBuiltinESMExports();
          },
        };
        NodeModule.syncBuiltinESMExports();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            "process.stdout.write('ready');process.stdin.resume()",
          ]),
        );
        yield* child.stdout.pipe(Stream.take(1), Stream.runDrain);
        const host = yield* Deferred.await(spawned);
        host.kill("SIGKILL");
        expect(Result.isFailure(yield* child.exitCode.pipe(Effect.result))).toBe(true);
        expect(yield* child.isRunning).toBe(false);
        const healthy = yield* spawner.spawn(ChildProcess.make("/bin/true"));
        expect(yield* healthy.exitCode).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("reports descriptor exhaustion without stopping another command in the same host", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const running = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          "-e",
          "process.stdout.write('ready');process.stdin.resume()",
        ]),
      );
      yield* running.stdout.pipe(Stream.take(1), Stream.runDrain);
      const failed = yield* spawner
        .spawn(ChildProcess.make("/t3-exhausted-spawn"))
        .pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(yield* running.isRunning).toBe(true);
      const healthy = yield* spawner.spawn(ChildProcess.make("/bin/true"));
      expect(yield* healthy.exitCode).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        SpawnHost.layerHost("/bin/sh", [
          "-c",
          'ulimit -n 64; exec "$@"',
          "sh",
          process.execPath,
          new URL("./spawnHost.test-fixture.ts", import.meta.url).pathname,
        ]).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.live("fails launcher startup without retrying the target on the server", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const result = yield* spawner.spawn(ChildProcess.make("/bin/true")).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        SpawnHost.layerHost("/t3-missing-launcher-30183", []).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});

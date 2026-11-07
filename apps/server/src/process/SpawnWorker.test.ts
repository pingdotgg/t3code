// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off - fixtures need real paths, the process resource list and the live environment.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as SpawnWorker from "./SpawnWorker.ts";

const layer = SpawnWorker.layer.pipe(Layer.provide(NodeServices.layer));
const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);
const node = (script: string, args: ReadonlyArray<string> = [], options = {}) =>
  ChildProcess.make(process.execPath, ["-e", script, ...args], options);

describe("SpawnWorker", () => {
  it.live("runs the server's Windows children on a launcher thread, not the server thread", () =>
    Effect.gen(function* () {
      for (const [platform, onServerThread] of [
        ["win32", false],
        ["linux", true],
      ] as const) {
        const launched = Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            node("process.stdout.write('ready');process.stdin.resume()"),
          );
          expect(yield* child.stdout.pipe(Stream.take(1), text)).toBe("ready");
          // The thread that called spawn owns the native process handle.
          expect(process.getActiveResourcesInfo().includes("ProcessWrap")).toBe(onServerThread);
          expect(yield* child.isRunning).toBe(true);
        });
        yield* launched.pipe(
          Effect.scoped,
          Effect.provide(SpawnWorker.layerServer.pipe(Layer.provide(NodeServices.layer))),
          Effect.provideService(HostProcess.Platform, platform),
        );
      }
    }),
  );

  it.live("preserves stdin, large output, env, cwd, literal args and additional descriptors", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const literal = "quote' \" $HOME; * & %PATH%";
      const cwd = NodeOS.tmpdir();
      const script = `
        const fs = require('node:fs');
        const input = fs.readFileSync(0, 'utf8');
        fs.writeSync(1, JSON.stringify([input, process.cwd(), process.env.SPAWN_WORKER_TEST, process.argv[1]]) + '\\n');
        fs.writeSync(1, 'a'.repeat(1024 * 1024));
        fs.writeSync(2, 'b'.repeat(1024 * 1024));
      `;
      for (let i = 0; i < 3; i++) {
        const child = yield* spawner.spawn(
          node(script, [literal], {
            cwd,
            env: { SPAWN_WORKER_TEST: "inherited value" },
            extendEnv: true,
            stdin: Stream.encodeText(Stream.make("stdin value")),
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [text(child.stdout), text(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        expect(stdout).toBe(
          JSON.stringify(["stdin value", NodePath.resolve(cwd), "inherited value", literal]) +
            "\n" +
            "a".repeat(1024 * 1024),
        );
        expect(stderr).toBe("b".repeat(1024 * 1024));
        expect(code).toBe(0);
      }
      // The launcher threads already exist, so this needs the server's environment at launch time.
      process.env.SPAWN_WORKER_LATE = "set after start";
      const late = yield* spawner.spawn(
        node("process.stdout.write(process.env.SPAWN_WORKER_LATE)"),
      );
      expect(yield* text(late.stdout)).toBe("set after start");
      delete process.env.SPAWN_WORKER_LATE;
      const extra = yield* spawner.spawn(
        node("require('node:fs').writeSync(3, 'fd3 value')", [], {
          additionalFds: { fd3: { type: "output" } },
        }),
      );
      const [fd3, extraCode] = yield* Effect.all([text(extra.getOutputFd(3)), extra.exitCode], {
        concurrency: "unbounded",
      });
      expect(fd3).toBe("fd3 value");
      expect(extraCode).toBe(0);
      const reader = yield* spawner.spawn(
        node("process.stdin.on('end', () => process.stdout.write('eof')).resume()"),
      );
      yield* Stream.fail("abandoned input").pipe(Stream.run(reader.stdin), Effect.ignore);
      expect(yield* text(reader.stdout)).toBe("eof");
      const pipeline = node("process.stdout.write('piped')").pipe(
        ChildProcess.pipeTo(
          node("process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"),
        ),
      );
      const piped = yield* spawner.spawn(pipeline);
      expect(yield* text(piped.stdout)).toBe("PIPED");
      expect(yield* piped.exitCode).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("reports launch errors and exit codes, and keeps launching after either", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missing = yield* spawner
        .spawn(ChildProcess.make("t3-missing-command-25245"))
        .pipe(Effect.result);
      expect(Result.isFailure(missing)).toBe(true);
      if (Result.isFailure(missing)) expect(missing.failure.reason._tag).toBe("NotFound");
      const failed = yield* spawner.spawn(node("process.exit(23)"));
      expect(yield* failed.exitCode).toBe(23);
      const healthy = yield* spawner.spawn(node("process.stdout.write('ok')"));
      expect(yield* text(healthy.stdout)).toBe("ok");
      expect(yield* healthy.exitCode).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("kills running commands, detached or not, and on scope interruption", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const detached of [true, false]) {
        const child = yield* spawner.spawn(
          node("process.stdout.write(String(process.pid));process.stdin.resume()", [], {
            detached,
          }),
        );
        const pid = yield* child.stdout.pipe(Stream.take(1), text);
        expect(Number(pid)).toBe(child.pid);
        yield* child.kill();
        expect(yield* child.isRunning).toBe(false);
      }
      const started = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const running = yield* Effect.gen(function* () {
        const scoped = yield* spawner.spawn(node("process.stdin.resume()"));
        yield* Deferred.succeed(started, scoped);
        return yield* Effect.never;
      }).pipe(Effect.scoped, Effect.forkChild);
      const scoped = yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(yield* scoped.isRunning).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

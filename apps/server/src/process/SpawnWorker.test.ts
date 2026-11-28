// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off - fixtures need real paths, the process resource list and the live environment.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as SpawnWorker from "./SpawnWorker.ts";

const envChdir = vi.hoisted(() => ({ supported: true }));
vi.mock("@t3tools/shared/envTrampoline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/envTrampoline")>()),
  supportsEnvChdir: () => Promise.resolve(envChdir.supported),
}));

const layer = SpawnWorker.layer.pipe(Layer.provide(NodeServices.layer));
const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);
const node = (script: string, args: ReadonlyArray<string> = [], options = {}) =>
  ChildProcess.make(process.execPath, ["-e", script, ...args], options);

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killPidBestEffort = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

describe("SpawnWorker", () => {
  it.live("runs children on a launcher thread where the server thread would wait on them", () =>
    Effect.gen(function* () {
      for (const [platform, hasEnvChdir, onServerThread] of [
        ["win32", true, false],
        ["linux", true, true],
        ["linux", false, false],
      ] as const) {
        envChdir.supported = hasEnvChdir;
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

  it.live("a short child's output ends while a sibling launched beside it still runs", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const untilStdin =
        "process.stdout.write('ready');process.stdin.once('data',()=>process.exit(0))";
      // Workers that own a child stay alive, as beside a running agent, so each round's two
      // launches land on two warm workers at once.
      yield* Effect.all(
        Array.from({ length: 4 }, () =>
          Effect.gen(function* () {
            const holder = yield* spawner.spawn(node(untilStdin));
            expect(yield* holder.stdout.pipe(Stream.take(1), text)).toBe("ready");
          }),
        ),
        { concurrency: "unbounded" },
      );
      for (let round = 0; round < 20; round++) {
        const [sibling, output] = yield* Effect.all(
          [
            spawner.spawn(node(untilStdin, [], { stdin: { stream: Stream.never } })),
            spawner
              .spawn(node("process.stdout.write('ok')"))
              .pipe(Effect.flatMap((child) => text(child.stdout))),
          ],
          { concurrency: "unbounded" },
        );
        expect(output).toBe("ok");
        expect(yield* sibling.isRunning).toBe(true);
      }
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
      // Direct callers such as the Claude adapter pass an AbortSignal, which cannot cross to a worker.
      const direct = SpawnWorker.spawnPiped(process.execPath, ["-e", "process.stdin.resume()"], {
        signal: AbortSignal.abort(),
      });
      const exited = new Promise((resolve) => direct.once("exit", () => resolve(direct.killed)));
      expect(yield* Effect.promise(() => exited)).toBe(true);
      // Windows has no process groups. Node ends a non-detached grandchild with its parent, but a
      // detached one, like a CLI's background shell, outlives it unless the kill ends the tree.
      if (HostProcess.Platform.defaultValue() === "win32") {
        const cli = SpawnWorker.spawnPiped(
          process.execPath,
          [
            "-e",
            "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{detached:true,stdio:'ignore'});process.stdout.write(String(c.pid));process.stdin.resume()",
          ],
          {},
        );
        const grandchild = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) =>
              cli.stdout.once("data", (pid) => resolve(Number(String(pid)))),
            ),
        );
        const cliExited = new Promise((resolve) => cli.once("exit", resolve));
        cli.kill();
        yield* Effect.promise(() => cliExited);
        const survived = (() => {
          try {
            return process.kill(grandchild, 0);
          } catch {
            return false;
          }
        })();
        if (survived) process.kill(grandchild);
        expect(survived).toBe(false);
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("kills live children and settles exit and stdin when the worker pool closes", () =>
    Effect.gen(function* () {
      const poolScope = yield* Scope.make();
      const childScope = yield* Scope.make();
      let pid = 0;
      let childExited = false;
      yield* Effect.gen(function* () {
        const services = yield* Layer.buildWithScope(layer, poolScope);
        const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
        const child = yield* spawner
          .spawn(node("process.stdout.write(String(process.pid));process.stdin.resume()"))
          .pipe(Scope.provide(childScope));
        pid = Number(yield* child.stdout.pipe(Stream.take(1), text));
        expect(isPidAlive(pid)).toBe(true);

        yield* Scope.close(poolScope, Exit.void);

        const exitCode = yield* child.exitCode.pipe(
          Effect.result,
          Effect.timeoutOption("2 seconds"),
        );
        childExited = Option.isSome(exitCode);
        expect(childExited).toBe(true);
        expect(isPidAlive(pid)).toBe(false);
        const stdinSettled = yield* Stream.empty.pipe(
          Stream.run(child.stdin),
          Effect.result,
          Effect.timeoutOption("2 seconds"),
        );
        expect(Option.isSome(stdinSettled)).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (pid > 0) killPidBestEffort(pid);
            if (childExited) yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
            yield* Scope.close(poolScope, Exit.void).pipe(Effect.ignore);
          }),
        ),
      );
    }),
  );
});

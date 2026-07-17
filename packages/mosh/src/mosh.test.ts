import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildMoshArgs, buildMoshSshCommand, MoshControlManager } from "./mosh.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.tail.example.ts.net",
  username: "emil",
  port: 2222,
};

describe("mosh", () => {
  it("builds an argument-safe roaming control session", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* buildMoshArgs(TARGET), [
        "--predict=adaptive",
        "--ssh=ssh -p 2222",
        "emil@devbox",
        "--",
        "sh",
        "-lc",
        "printf 'T3_MOSH_CONTROL_READY\\n'; exec sh -c 'while :; do sleep 3600; done'",
      ]);
    }));

  it("supports a restricted UDP range without shell interpolation", () =>
    Effect.gen(function* () {
      const args = yield* buildMoshArgs(TARGET, { udpPortRange: "60000:60010" });
      assert.include(args, "--port=60000:60010");
      assert.equal(args.at(-4), "--");
    }));

  it("uses the default ssh command when no custom port is configured", () => {
    assert.equal(buildMoshSshCommand({ ...TARGET, port: null }), "ssh");
  });

  it.effect("reuses a healthy control session and closes it explicitly", () => {
    let sessionRunning = true;
    let sessionKillCount = 0;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const finishedHandle = (pid: number) =>
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    const sessionHandle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(303),
      exitCode: Effect.never,
      isRunning: Effect.sync(() => sessionRunning),
      kill: () =>
        Effect.sync(() => {
          sessionRunning = false;
          sessionKillCount += 1;
        }),
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.make(new TextEncoder().encode("T3_MOSH_CONTROL_READY\n")),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((process) => {
        const spec = process as unknown as { command: string; args: readonly string[] };
        commands.push(spec);
        return Effect.succeed(
          commands.length < 3 ? finishedHandle(300 + commands.length) : sessionHandle,
        );
      }),
    );

    return Effect.gen(function* () {
      const manager = yield* MoshControlManager;
      const first = yield* manager.ensure(TARGET);
      const second = yield* manager.ensure(TARGET);

      assert.equal(first.pid, 303);
      assert.strictEqual(second, first);
      assert.equal(commands.length, 3);
      assert.deepEqual(
        commands.map(({ command }) => command),
        ["mosh", "ssh", "mosh"],
      );

      yield* manager.disconnect(TARGET);
      assert.equal(sessionKillCount, 1);
      assert.isNull(yield* manager.status(TARGET));
    }).pipe(
      Effect.provide(MoshControlManager.layer),
      Effect.provide(spawner),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("replaces a dropped control session without disturbing the remote environment", () => {
    let firstSessionRunning = true;
    let firstSessionKillCount = 0;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const finishedHandle = (pid: number) =>
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    const sessionHandle = (
      pid: number,
      isRunning: Effect.Effect<boolean>,
      onKill: Effect.Effect<void>,
    ) =>
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.never,
        isRunning,
        kill: () => onKill,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode("T3_MOSH_CONTROL_READY\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    const firstSession = sessionHandle(
      503,
      Effect.sync(() => firstSessionRunning),
      Effect.sync(() => {
        firstSessionRunning = false;
        firstSessionKillCount += 1;
      }),
    );
    const secondSession = sessionHandle(506, Effect.succeed(true), Effect.void);
    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((process) => {
        const spec = process as unknown as { command: string; args: readonly string[] };
        commands.push(spec);
        if (commands.length === 3) return Effect.succeed(firstSession);
        if (commands.length === 6) return Effect.succeed(secondSession);
        return Effect.succeed(finishedHandle(500 + commands.length));
      }),
    );

    return Effect.gen(function* () {
      const manager = yield* MoshControlManager;
      const first = yield* manager.ensure(TARGET);
      firstSessionRunning = false;
      const replacement = yield* manager.ensure(TARGET);

      assert.equal(first.pid, 503);
      assert.equal(replacement.pid, 506);
      assert.equal(firstSessionKillCount, 1);
      assert.deepEqual(
        commands.map(({ command }) => command),
        ["mosh", "ssh", "mosh", "mosh", "ssh", "mosh"],
      );
      assert.strictEqual(yield* manager.status(TARGET), replacement);
    }).pipe(
      Effect.provide(MoshControlManager.layer),
      Effect.provide(spawner),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("fails setup when the roaming UDP session never becomes ready", () => {
    let spawnCount = 0;
    let sessionKilled = false;
    const handle = (running: boolean) =>
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(400 + spawnCount),
        exitCode: running ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(running),
        kill: () =>
          Effect.sync(() => {
            sessionKilled = true;
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: running ? Stream.never : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        spawnCount += 1;
        return Effect.succeed(handle(spawnCount === 3));
      }),
    );

    return Effect.gen(function* () {
      const manager = yield* MoshControlManager;
      const fiber = yield* Effect.forkChild(manager.ensure(TARGET));
      yield* TestClock.adjust("20 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      assert.equal(error._tag, "MoshSessionStartError");
      assert.include(error.message, "roaming UDP session");
      assert.isTrue(sessionKilled);
      assert.isNull(yield* manager.status(TARGET));
    }).pipe(
      Effect.provide(MoshControlManager.layer),
      Effect.provide(spawner),
      Effect.provide(NodeServices.layer),
    );
  });
});

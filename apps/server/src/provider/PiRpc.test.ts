import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import { makePiRpcConnection } from "./PiRpc.ts";

/** Deliberately outside the valid pid range so a real group-kill can never land. */
const FAKE_PID = 999_999_999;

/** A pi process that exits with code 0 right after spawning. */
const exitedPiSpawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
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
    }),
  ),
);

it.effect("terminates extension subprocesses that outlive pi in its process group", () =>
  Effect.gen(function* () {
    const signals: Array<[number, string | number | undefined]> = [];
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0 && !groupAlive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal === "SIGTERM") groupAlive = false;
      return true;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => kill.mockRestore()));

    const connection = yield* makePiRpcConnection({
      command: "pi",
      args: ["--mode", "rpc"],
      cwd: undefined,
      env: {},
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, exitedPiSpawner),
      Effect.provideService(HostProcessPlatform, "linux"),
    );
    assert.equal(yield* connection.exited, 0);

    const terminating = yield* Effect.forkChild(connection.terminate);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(terminating);

    assert.deepInclude(signals, [-FAKE_PID, "SIGTERM"]);
    assert.notDeepInclude(signals, [-FAKE_PID, "SIGKILL"]);
  }).pipe(Effect.scoped),
);

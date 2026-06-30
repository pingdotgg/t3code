import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { layer, make, type ChildProcessShutdownSignal } from "./boundedChildProcessSpawner.ts";

const makeHandle = (input: {
  readonly pid: number;
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly isRunning: Effect.Effect<boolean>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
  readonly unref?: ChildProcessSpawner.ChildProcessHandle["unref"];
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: input.exitCode,
    isRunning: input.isRunning,
    kill: input.kill ?? (() => Effect.void),
    unref: input.unref ?? Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const errnoCode = (cause: unknown) =>
  cause instanceof Error ? Reflect.get(cause, "code") : undefined;

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errnoCode(cause) !== "ESRCH";
  }
};

const killProcessGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
  }
};

const readFixturePids = (line: string) => {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected the child fixture to print an object");
  }
  const pid = Reflect.get(value, "pid");
  const descendantPid = Reflect.get(value, "descendantPid");
  if (typeof pid !== "number" || typeof descendantPid !== "number") {
    throw new Error("Expected numeric child fixture pids");
  }
  return { pid, descendantPid };
};

const waitForProcessesToStop = Effect.fn("waitForProcessesToStop")(function* (
  pids: ReadonlyArray<number>,
  timeoutMs: number,
) {
  let remainingMs = timeoutMs;
  while (pids.some(isProcessAlive)) {
    if (remainingMs <= 0) return false;
    const delayMs = Math.min(10, remainingMs);
    yield* Effect.sleep(delayMs);
    remainingMs -= delayMs;
  }
  return true;
});

it.effect("closes the delegate scope after a natural child exit", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const delegateClosed = yield* Deferred.make<void>();
    const handle = makeHandle({
      pid: 1,
      exitCode: Deferred.await(exited),
      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
    });
    const delegate = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(delegateClosed, undefined));
        return handle;
      }),
    );
    const spawner = make(delegate);
    const callerScope = yield* Scope.make();

    const spawned = yield* spawner
      .spawn(ChildProcess.make("unused"))
      .pipe(Effect.provideService(Scope.Scope, callerScope));
    expect(spawned.pid).toBe(handle.pid);

    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
    yield* Deferred.await(delegateClosed).pipe(Effect.timeout("1 second"));
    yield* Scope.close(callerScope, Exit.void);
  }),
);

it.effect("preserves unref as an opt-out from scope-owned termination", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const signals: Array<ChildProcessShutdownSignal> = [];
    let running = true;
    const handle = makeHandle({
      pid: 43,
      exitCode: Deferred.await(exited),
      isRunning: Effect.sync(() => running),
      kill: ({ killSignal } = {}) =>
        Effect.sync(() => {
          if (killSignal === "SIGTERM" || killSignal === "SIGKILL") signals.push(killSignal);
        }),
    });
    const spawner = make(
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
      {
        termGraceMs: 0,
        killGraceMs: 0,
      },
    );
    const callerScope = yield* Scope.make();
    const spawned = yield* spawner
      .spawn(ChildProcess.make("unused"))
      .pipe(Effect.provideService(Scope.Scope, callerScope));

    const reref = yield* spawned.unref;
    yield* Scope.close(callerScope, Exit.void);

    expect(signals).toEqual([]);
    yield* reref;
    running = false;
    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
  }),
);

it.effect("bounds explicit handle kill calls and escalates to SIGKILL", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const signals: Array<ChildProcessShutdownSignal> = [];
    let running = true;
    const handle = makeHandle({
      pid: 44,
      exitCode: Deferred.await(exited),
      isRunning: Effect.sync(() => running),
      kill: ({ killSignal } = {}) =>
        Effect.sync(() => {
          if (killSignal !== "SIGTERM" && killSignal !== "SIGKILL") return;
          signals.push(killSignal);
          if (killSignal === "SIGKILL") running = false;
        }).pipe(Effect.andThen(Deferred.await(exited)), Effect.asVoid),
    });
    const spawner = make(
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
      {
        termGraceMs: 0,
        killGraceMs: 0,
      },
    );
    const callerScope = yield* Scope.make();
    const spawned = yield* spawner
      .spawn(ChildProcess.make("unused"))
      .pipe(Effect.provideService(Scope.Scope, callerScope));

    yield* spawned.kill({ forceKillAfter: 0 });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(137));
    yield* Scope.close(callerScope, Exit.void);
  }),
);

it.effect("does not wait for the delegate's unbounded finalizer", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const delegateCloseStarted = yield* Deferred.make<void>();
    const allowDelegateClose = yield* Deferred.make<void>();
    const signals: Array<ChildProcessShutdownSignal> = [];
    let running = true;
    const handle = makeHandle({
      pid: 42,
      exitCode: Deferred.await(exited),
      isRunning: Effect.sync(() => running),
      kill: ({ killSignal } = {}) =>
        Effect.sync(() => {
          if (killSignal !== "SIGTERM" && killSignal !== "SIGKILL") return;
          signals.push(killSignal);
          if (killSignal === "SIGKILL") running = false;
        }),
    });
    const delegate = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(delegateCloseStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowDelegateClose)),
          ),
        );
        return handle;
      }),
    );
    const spawner = make(delegate, {
      termGraceMs: 0,
      killGraceMs: 0,
    });
    const callerScope = yield* Scope.make();

    yield* spawner
      .spawn(ChildProcess.make("unused"))
      .pipe(Effect.provideService(Scope.Scope, callerScope));
    yield* Scope.close(callerScope, Exit.void);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    yield* Deferred.await(delegateCloseStarted).pipe(Effect.timeout("1 second"));
    yield* Deferred.succeed(allowDelegateClose, undefined);
    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(137));
  }),
);

it.effect(
  "kills a TERM-ignoring Node child and its descendant without blocking scope close",
  () => {
    const descendantScript = `
    process.on("SIGTERM", () => {});
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `;
    const childScript = `
    const { spawn } = require("node:child_process");
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    descendant.stdout.once("data", () => {
      console.log(JSON.stringify({ pid: process.pid, descendantPid: descendant.pid }));
    });
    setInterval(() => {}, 1_000);
  `;
    const boundedLayer = layer({
      termGraceMs: 100,
      killGraceMs: 1_000,
      pollIntervalMs: 10,
    }).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform === "win32") return;

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const callerScope = yield* Scope.make();
      const handle = yield* spawner
        .spawn(ChildProcess.make(process.execPath, ["-e", childScript]))
        .pipe(Effect.provideService(Scope.Scope, callerScope));
      const line = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runHead,
        Effect.timeout("2 seconds"),
        Effect.map(Option.getOrThrow),
      );
      const pids = readFixturePids(line);
      yield* Effect.addFinalizer(() => Effect.sync(() => killProcessGroup(pids.pid)));

      const closeFiber = yield* Scope.close(callerScope, Exit.void).pipe(
        Effect.forkDetach({ startImmediately: true }),
      );
      yield* Fiber.join(closeFiber).pipe(Effect.timeout("2 seconds"));

      expect(yield* waitForProcessesToStop([pids.pid, pids.descendantPid], 2_000)).toBe(true);
      expect(isProcessAlive(pids.pid)).toBe(false);
      expect(isProcessAlive(pids.descendantPid)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(boundedLayer), TestClock.withLive);
  },
);

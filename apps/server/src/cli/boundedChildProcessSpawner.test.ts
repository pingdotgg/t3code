import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as BoundedChildProcessSpawner from "./boundedChildProcessSpawner.ts";

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

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(cause instanceof Error && Reflect.get(cause, "code") === "ESRCH");
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
    let closeCount = 0;
    const handle = makeHandle({
      pid: 1,
      exitCode: Deferred.await(exited),
      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
    });
    const delegate = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closeCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(delegateClosed, undefined))),
        );
        return handle;
      }),
    );
    const spawner = BoundedChildProcessSpawner.make(delegate);
    const callerScope = yield* Scope.make();

    const spawned = yield* spawner
      .spawn(ChildProcess.make("unused"))
      .pipe(Effect.provideService(Scope.Scope, callerScope));
    expect(spawned.pid).toBe(handle.pid);

    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
    yield* Deferred.await(delegateClosed).pipe(Effect.timeout("1 second"));
    yield* Scope.close(callerScope, Exit.void);
    expect(closeCount).toBe(1);
  }),
);

it.effect("terminates a child re-referenced after its owner scope closes", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const signals: Array<ChildProcess.Signal> = [];
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
    const spawner = BoundedChildProcessSpawner.make(
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
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    running = false;
    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
  }),
);

it.effect("preserves an explicit kill without adding a timeout", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const allowKill = yield* Deferred.make<void>();
    const killOptions: Array<ChildProcess.KillOptions | undefined> = [];
    let running = true;
    const handle = makeHandle({
      pid: process.pid,
      exitCode: Deferred.await(exited),
      isRunning: Effect.sync(() => running),
      kill: (options) =>
        Effect.sync(() => {
          killOptions.push(options);
        }).pipe(Effect.andThen(Deferred.await(allowKill))),
    });
    const spawner = BoundedChildProcessSpawner.make(
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
    );
    const callerScope = yield* Scope.make();
    const spawned = yield* spawner
      .spawn(ChildProcess.make("unused"))
      .pipe(Effect.provideService(Scope.Scope, callerScope));

    const killFiber = yield* spawned.kill().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 hour");

    expect(killOptions).toEqual([undefined]);
    expect(killFiber.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(allowKill, undefined);
    yield* Fiber.join(killFiber);
    running = false;
    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
    yield* Scope.close(callerScope, Exit.void);
  }),
);

it.effect("preserves explicit kill options and failures", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const receivedOptions: Array<ChildProcess.KillOptions | undefined> = [];
    const killError = PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "kill",
      cause: new Error("kill failed"),
    });
    let running = true;
    const handle = makeHandle({
      pid: process.pid,
      exitCode: Deferred.await(exited),
      isRunning: Effect.sync(() => running),
      kill: (options) =>
        Effect.sync(() => {
          receivedOptions.push(options);
        }).pipe(Effect.andThen(Effect.fail(killError))),
    });
    const spawner = BoundedChildProcessSpawner.make(
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
    );
    const callerScope = yield* Scope.make();
    const spawned = yield* spawner
      .spawn(ChildProcess.make("unused"))
      .pipe(Effect.provideService(Scope.Scope, callerScope));
    const killOptions = {
      killSignal: "SIGINT",
      forceKillAfter: "Infinity",
    } as const;

    const error = yield* spawned.kill(killOptions).pipe(Effect.flip);

    expect(receivedOptions).toEqual([killOptions]);
    expect(error).toBe(killError);
    running = false;
    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
    yield* Scope.close(callerScope, Exit.void);
  }),
);

it.effect("bounds later kill finalizers and returns before the delegate finalizer can block", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const delegateCloseStarted = yield* Deferred.make<void>();
    const allowDelegateClose = yield* Deferred.make<void>();
    const signals: Array<ChildProcess.Signal> = [];
    let killCallCount = 0;
    let running = true;
    const handle = makeHandle({
      pid: process.pid,
      exitCode: Deferred.await(exited),
      isRunning: Effect.sync(() => running),
      kill: ({ killSignal } = {}) =>
        Effect.sync(() => {
          killCallCount += 1;
          if (killSignal !== "SIGTERM" && killSignal !== "SIGKILL") return;
          signals.push(killSignal);
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
    const spawner = BoundedChildProcessSpawner.make(delegate, {
      termGraceMs: 0,
      killGraceMs: 0,
    });
    const callerScope = yield* Scope.make();

    const spawned = yield* spawner
      .spawn(ChildProcess.make("unused"))
      .pipe(Effect.provideService(Scope.Scope, callerScope));
    yield* Scope.addFinalizer(callerScope, spawned.kill().pipe(Effect.ignore));
    yield* Scope.close(callerScope, Exit.void);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(killCallCount).toBe(2);
    expect(yield* Deferred.poll(delegateCloseStarted)).toEqual(Option.none());
    running = false;
    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(137));
    yield* Deferred.await(delegateCloseStarted).pipe(Effect.timeout("1 second"));
    yield* Deferred.succeed(allowDelegateClose, undefined);
  }),
);

it.effect("kills a Windows child process tree without blocking scope close", (context) => {
  const descendantScript = `
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `;
  const childScript = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    descendant.stdout.once("data", () => {
      console.log(JSON.stringify({ pid: process.pid, descendantPid: descendant.pid }));
    });
    setInterval(() => {}, 1_000);
  `;
  const boundedLayer = BoundedChildProcessSpawner.layer({
    termGraceMs: 100,
    killGraceMs: 1_000,
  }).pipe(Layer.provideMerge(NodeServices.layer));

  return Effect.gen(function* () {
    if ((yield* HostProcessPlatform) !== "win32") context.skip("Windows only");

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const callerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(callerScope, Exit.void).pipe(Effect.ignore));
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

    const closeFiber = yield* Scope.close(callerScope, Exit.void).pipe(
      Effect.forkDetach({ startImmediately: true }),
    );
    yield* Fiber.join(closeFiber).pipe(Effect.timeout("2 seconds"));

    expect(yield* waitForProcessesToStop([pids.pid, pids.descendantPid], 2_000)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(boundedLayer), TestClock.withLive);
});

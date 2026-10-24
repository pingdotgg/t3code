import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

// Model the spawner's process-group release without native timers or OS signals.
export const makeFakeBackendProcess = Effect.fn("test.makeFakeBackendProcess")(function* (
  cooperative: boolean,
) {
  const started = yield* Deferred.make<void>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const signals = yield* Queue.unbounded<"SIGTERM" | "SIGKILL">();
  const receivedSignals: Array<"SIGTERM" | "SIGKILL"> = [];
  let running = false;
  let terminateGrace = Duration.zero;
  const killWait = Duration.seconds(1);
  const signal = (value: "SIGTERM" | "SIGKILL") =>
    Effect.sync(() => receivedSignals.push(value)).pipe(
      Effect.andThen(Queue.offer(signals, value)),
      Effect.asVoid,
    );
  const exit = Effect.sync(() => {
    running = false;
  }).pipe(Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))), Effect.asVoid);
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") {
          return yield* Effect.die("Expected a standard backend command");
        }
        terminateGrace = Duration.fromInputUnsafe(command.options.forceKillAfter ?? 0);
        running = true;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* signal("SIGTERM");
            if (!cooperative) {
              yield* Effect.sleep(terminateGrace);
              yield* signal("SIGKILL");
              // Exit acknowledgement can consume the spawner's final one-second wait.
              yield* Effect.sleep(killWait);
            }
            yield* exit;
          }),
        );
        yield* Deferred.succeed(started, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          exitCode: Deferred.await(exited),
          isRunning: Effect.sync(() => running),
          kill: () => exit,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
  return {
    layer,
    started: Deferred.await(started),
    signals,
    receivedSignals,
    isRunning: Effect.sync(() => running),
    terminateGrace: Effect.sync(() => terminateGrace),
    killWait,
  };
});

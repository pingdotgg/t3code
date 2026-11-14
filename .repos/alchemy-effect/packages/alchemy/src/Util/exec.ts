import * as Effect from "effect/Effect";
import type { ChildProcess } from "effect/process";
import * as Stream from "effect/Stream";

export const exec = Effect.fn("exec")(function* (command: ChildProcess.Command) {
  const handle = yield* command;
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      handle.stdout.pipe(Stream.decodeText, Stream.mkString),
      handle.stderr.pipe(Stream.decodeText, Stream.mkString),
    ],
    { concurrency: 3 },
  );
  return { exitCode, stdout, stderr };
});

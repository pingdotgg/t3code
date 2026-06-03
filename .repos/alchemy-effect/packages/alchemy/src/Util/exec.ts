import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ChildProcess } from "effect/unstable/process";

export const exec = Effect.fn("exec")(function* (
  command: ChildProcess.Command,
) {
  const handle = yield* command;
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 3 },
  );
  return { exitCode, stdout, stderr };
});

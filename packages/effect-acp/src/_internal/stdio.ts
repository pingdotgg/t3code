import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ProcessStderrCapture } from "@t3tools/shared/processStderrCapture";

import * as AcpError from "../errors.ts";

const encoder = new TextEncoder();

/**
 * Build inverted Stdio for talking to a child ACP process over its stdio pipes.
 *
 * Child stderr is **not** consumed here — callers must capture `handle.stderr`
 * separately (see `runProcessStderrCapture`) so the pipe cannot block and the
 * diagnostic tail remains available after exit.
 */
export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    // Write-side stderr sink for this Stdio view; child stderr is a Stream on the handle.
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  stderrCapture?: ProcessStderrCapture,
): Effect.Effect<AcpError.AcpError> =>
  Effect.match(handle.exitCode, {
    onFailure: (cause) =>
      new AcpError.AcpTransportError({
        operation: "read-process-exit-status",
        pid: handle.pid,
        cause,
      }),
    onSuccess: (code) => {
      const stderrTail = stderrCapture?.getTail();
      return new AcpError.AcpProcessExitedError({
        code,
        pid: handle.pid,
        ...(stderrTail ? { stderrTail } : {}),
      });
    },
  });

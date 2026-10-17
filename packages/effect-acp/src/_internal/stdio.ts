import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import { ChildProcessSpawner } from "effect/process";

import * as AcpError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
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

// Effect's Node spawner fails `exitCode` when a signal ends the child, naming
// the signal only in the cause's message.
const terminationSignal = (cause: PlatformError.PlatformError) => {
  const error = cause.reason.cause;
  return error instanceof Error
    ? /receipt of signal: '(?<signal>SIG[A-Z0-9]+)'/.exec(error.message)?.groups?.signal
    : undefined;
};

/** Classifies how the ACP child ended once its connection terminates. */
export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
): Effect.Effect<AcpError.AcpError> =>
  Effect.match(handle.exitCode, {
    onFailure: (cause) => {
      const signal = terminationSignal(cause);
      return signal === undefined
        ? new AcpError.AcpTransportError({
            operation: "read-process-exit-status",
            pid: handle.pid,
            cause,
          })
        : new AcpError.AcpProcessExitedError({ signal, pid: handle.pid, cause });
    },
    onSuccess: (code) => new AcpError.AcpProcessExitedError({ code, pid: handle.pid }),
  });

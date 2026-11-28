import * as NodeUtil from "node:util";

import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();
const PROCESS_EXIT_DRAIN_GRACE = "250 millis";

export const makeChildStdio = (
  handle: Pick<ChildProcessSpawner.ChildProcessHandle, "stdin" | "stdout" | "exitCode">,
  stderrDrained: Effect.Effect<void>,
) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout.pipe(
      // Descendants can retain stdout after the owner exits; drain its final frames for a bounded time.
      Stream.interruptWhen(
        handle.exitCode.pipe(Effect.ignore, Effect.andThen(Effect.sleep(PROCESS_EXIT_DRAIN_GRACE))),
      ),
      // Finish stderr separately from the protocol's exit-status deadline.
      Stream.onEnd(stderrDrained),
    ),
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

const STDERR_TAIL_MAX_CHARS = 8_192;
const STDERR_EXCERPT_MAX_CHARS = 512;
// `Error: …`, `TypeError: …`, `Error [ERR_MODULE_NOT_FOUND]: …`, `error: …`, `ERROR: …`, `fatal: …`
const ERROR_LINE_PATTERN = /^(?:[a-z]*error|fatal)(?: ?\[[^\]]+\])?:\s*\S/i;
const EXIT_SUMMARY_PATTERN = /\b(?:exit status|exit code|exited with code)\s+\d+\.?$/i;
// Rust panics and aborts end with `note: run with \`RUST_BACKTRACE=1\` …` after the cause.
const TRAILING_NOTE_PATTERN = /^note:\s/i;

export const appendStderrTail = (current: string, chunk: string): string => {
  const next = `${current}${chunk}`;
  return next.length <= STDERR_TAIL_MAX_CHARS ? next : next.slice(-STDERR_TAIL_MAX_CHARS);
};

// Node launchers print the actionable error between a source excerpt and stack frames.
export const stderrExcerpt = (tail: string): string | undefined => {
  const lines = NodeUtil.stripVTControlCharacters(tail)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  const errorIndex = lines.findLastIndex((candidate) => ERROR_LINE_PATTERN.test(candidate));
  const causeIndex = lines.findLastIndex((candidate) => !TRAILING_NOTE_PATTERN.test(candidate));
  const endsWithNote = causeIndex !== -1 && causeIndex < lines.length - 1;
  const lineIndex =
    errorIndex === -1 || EXIT_SUMMARY_PATTERN.test(lines.at(-1) ?? "")
      ? endsWithNote
        ? causeIndex
        : lines.length - 1
      : errorIndex;
  const line = lines[lineIndex];
  if (line === undefined) {
    return undefined;
  }
  // Wrappers can print the actual failure before their generic exit-status summary,
  // and a Rust panic prints its location on the line before its message.
  const contextLines = EXIT_SUMMARY_PATTERN.test(line)
    ? 2
    : lineIndex === causeIndex && endsWithNote
      ? 1
      : 0;
  const excerpt = lines.slice(Math.max(0, lineIndex - contextLines), lineIndex + 1).join(" | ");
  if (excerpt.length <= STDERR_EXCERPT_MAX_CHARS) {
    return excerpt;
  }
  return excerpt !== line
    ? `…${excerpt.slice(-(STDERR_EXCERPT_MAX_CHARS - 1))}`
    : `${excerpt.slice(0, STDERR_EXCERPT_MAX_CHARS - 1)}…`;
};

export const makeStderrTail = Effect.fn("makeStderrTail")(function* (
  stderr: ChildProcessSpawner.ChildProcessHandle["stderr"],
) {
  const tail = yield* Ref.make("");
  const drain = yield* stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Ref.update(tail, (current) => appendStderrTail(current, chunk))),
    Effect.ignore,
    Effect.forkScoped,
  );
  return {
    read: Ref.get(tail),
    awaitDrained: Fiber.join(drain).pipe(Effect.timeout("250 millis"), Effect.ignore),
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "isRunning" | "pid"
>;

export const makeTerminationError = Effect.fn("CodexAppServer.makeTerminationError")(function* (
  handle: ChildProcessTerminationHandle,
  stderrTail: Effect.Effect<string>,
) {
  const status = yield* Effect.result(handle.exitCode);
  // A signal exit and a failed stdin write can both fail the exit-code read.
  if (
    Result.isFailure(status) &&
    (yield* handle.isRunning.pipe(Effect.orElseSucceed(() => true)))
  ) {
    return new CodexError.CodexAppServerTransportError({
      operation: "read-process-exit-status",
      pid: handle.pid,
      cause: status.failure,
    });
  }
  const stderr = stderrExcerpt(yield* stderrTail);
  return new CodexError.CodexAppServerProcessExitedError({
    ...(Result.isSuccess(status) ? { code: status.success } : { cause: status.failure }),
    pid: handle.pid,
    ...(stderr ? { stderr } : {}),
  });
});

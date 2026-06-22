import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();
const RedactedDiagnosticValue = "[REDACTED]";
const StderrDrainGracePeriod = "50 millis";
const sensitiveKeyValuePattern =
  /((?:^|[^A-Za-z0-9_-])(?:[A-Za-z0-9_.-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|bearer[_-]?token|token|secret|password|passwd|private[_-]?key|credential)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/giu;
const bearerCredentialPattern = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/giu;
const openAiSecretPattern = /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/gu;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const urlCredentialPattern = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^@\s/]+)@/gu;

interface StderrTailState {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

export interface StderrTailSnapshot {
  readonly stderrTail: string;
  readonly stderrTruncated: boolean;
}

export interface StderrTailDiagnostics {
  readonly snapshot: Effect.Effect<StderrTailSnapshot>;
  readonly awaitDrain?: Effect.Effect<unknown, never>;
}

const emptyStderrTailState: StderrTailState = {
  bytes: new Uint8Array(),
  truncated: false,
};

const redactSensitiveStderr = (stderr: string): string =>
  stderr
    .replace(urlCredentialPattern, `$1${RedactedDiagnosticValue}@`)
    .replace(bearerCredentialPattern, `$1 ${RedactedDiagnosticValue}`)
    .replace(sensitiveKeyValuePattern, `$1${RedactedDiagnosticValue}`)
    .replace(openAiSecretPattern, RedactedDiagnosticValue)
    .replace(jwtPattern, RedactedDiagnosticValue);

const appendTailBytes = (
  state: StderrTailState,
  chunk: Uint8Array,
  byteLimit: number,
): StderrTailState => {
  if (chunk.byteLength === 0) {
    return state;
  }
  if (byteLimit <= 0) {
    return {
      bytes: new Uint8Array(),
      truncated: true,
    };
  }
  if (chunk.byteLength >= byteLimit) {
    return {
      bytes: chunk.slice(chunk.byteLength - byteLimit),
      truncated: state.truncated || state.bytes.byteLength > 0 || chunk.byteLength > byteLimit,
    };
  }

  const combinedLength = state.bytes.byteLength + chunk.byteLength;
  if (combinedLength <= byteLimit) {
    const next = new Uint8Array(combinedLength);
    next.set(state.bytes);
    next.set(chunk, state.bytes.byteLength);
    return {
      bytes: next,
      truncated: state.truncated,
    };
  }

  const droppedBytes = combinedLength - byteLimit;
  const keptPrevious = state.bytes.subarray(Math.min(droppedBytes, state.bytes.byteLength));
  const next = new Uint8Array(byteLimit);
  next.set(keptPrevious);
  next.set(chunk, keptPrevious.byteLength);
  return {
    bytes: next,
    truncated: true,
  };
};

export const makeStderrTailCapture = Effect.fn("makeStderrTailCapture")(function* (
  stderr: Stream.Stream<Uint8Array, unknown>,
  byteLimit = CodexError.CodexAppServerProcessStderrTailByteLimit,
) {
  const decoder = new TextDecoder();
  const state = yield* Ref.make(emptyStderrTailState);

  return {
    drain: stderr.pipe(
      Stream.runForEach((chunk) =>
        Ref.update(state, (current) => appendTailBytes(current, chunk, byteLimit)),
      ),
      Effect.ignore,
    ),
    snapshot: Ref.get(state).pipe(
      Effect.map((current): StderrTailSnapshot => {
        const stderrTail = redactSensitiveStderr(decoder.decode(current.bytes)).trim();
        return {
          stderrTail,
          stderrTruncated: current.truncated,
        };
      }),
    ),
  };
});

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

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  stderrDiagnostics?: StderrTailDiagnostics,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.gen(function* () {
    const exitStatus = yield* Effect.match(handle.exitCode, {
      onFailure: (cause) =>
        ({
          _tag: "failure" as const,
          error: new CodexError.CodexAppServerTransportError({
            operation: "read-process-exit-status",
            pid: handle.pid,
            cause,
          }),
        }) as const,
      onSuccess: (code) => ({ _tag: "success" as const, code }) as const,
    });
    if (exitStatus._tag === "failure") {
      return exitStatus.error;
    }
    if (stderrDiagnostics?.awaitDrain) {
      yield* stderrDiagnostics.awaitDrain.pipe(
        Effect.timeoutOption(StderrDrainGracePeriod),
        Effect.ignore,
      );
    }
    const snapshot = stderrDiagnostics ? yield* stderrDiagnostics.snapshot : undefined;
    return new CodexError.CodexAppServerProcessExitedError({
      code: exitStatus.code,
      pid: handle.pid,
      ...(snapshot?.stderrTail
        ? {
            stderrTail: snapshot.stderrTail,
            stderrTruncated: snapshot.stderrTruncated,
          }
        : {}),
    });
  });

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";
import { makeStderrTailCapture, makeTerminationError } from "./stdio.ts";

const encoder = new TextEncoder();

describe("Codex App Server child process termination", () => {
  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(51),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 51);
      assert.equal(error.code, 9);
      assert.equal(error.message, "Codex App Server process exited with code 9");
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );

  it.effect("adds the trimmed truncated stderr tail to process-exited errors", () =>
    Effect.gen(function* () {
      const capture = yield* makeStderrTailCapture(
        Stream.fromIterable([encoder.encode("prefix-Access is denied\n")]),
        17,
      );
      yield* capture.drain;
      const snapshot = yield* capture.snapshot;
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(53),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        { snapshot: Effect.succeed(snapshot) },
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.stderrTail, "Access is denied");
      assert.equal(error.stderrTruncated, true);
      assert.include(error.message, "recent stderr (last 4096 bytes, truncated)");
      assert.include(error.message, "Access is denied");
    }),
  );

  it.effect("does not mark an exact-limit first stderr chunk as truncated", () =>
    Effect.gen(function* () {
      const capture = yield* makeStderrTailCapture(
        Stream.fromIterable([encoder.encode("abcde")]),
        5,
      );

      yield* capture.drain;

      const snapshot = yield* capture.snapshot;
      assert.equal(snapshot.stderrTail, "abcde");
      assert.equal(snapshot.stderrTruncated, false);
    }),
  );

  it.effect("redacts secret-shaped stderr before building process-exited messages", () =>
    Effect.gen(function* () {
      const apiKey = "sk-proj-privateDiagnosticSecret1234567890";
      const bearerToken = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJwcml2YXRlIn0.signaturePart123";
      const capture = yield* makeStderrTailCapture(
        Stream.fromIterable([
          encoder.encode(
            `OPENAI_API_KEY=${apiKey}\nAuthorization: Bearer ${bearerToken}\nAccess is denied\n`,
          ),
        ]),
      );

      yield* capture.drain;
      const snapshot = yield* capture.snapshot;
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(54),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        { snapshot: Effect.succeed(snapshot) },
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.notInclude(error.stderrTail ?? "", apiKey);
      assert.notInclude(error.stderrTail ?? "", bearerToken);
      assert.notInclude(error.message, apiKey);
      assert.notInclude(error.message, bearerToken);
      assert.include(error.message, "[REDACTED]");
      assert.include(error.message, "Access is denied");
    }),
  );

  it.effect("snapshots stderr after exit status and a bounded drain opportunity", () =>
    Effect.gen(function* () {
      const stderrTail = yield* Ref.make("before-exit");
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(55),
          exitCode: Ref.set(stderrTail, "after-exit").pipe(
            Effect.as(ChildProcessSpawner.ExitCode(1)),
          ),
        },
        {
          awaitDrain: Ref.update(stderrTail, (current) => `${current}-after-drain`),
          snapshot: Ref.get(stderrTail).pipe(
            Effect.map((stderrTail) => ({ stderrTail, stderrTruncated: false })),
          ),
        },
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.stderrTail, "after-exit-after-drain");
    }),
  );
});

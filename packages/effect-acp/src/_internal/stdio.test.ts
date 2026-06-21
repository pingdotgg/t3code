import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AcpError from "../errors.ts";
import { makeTerminationError } from "./stdio.ts";

describe("ACP child process termination", () => {
  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(41),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(7)),
      });

      assert.instanceOf(error, AcpError.AcpProcessExitedError);
      assert.equal(error.pid, 41);
      assert.equal(error.code, 7);
      assert.equal(error.message, "ACP process exited with code 7");
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
        pid: ChildProcessSpawner.ProcessId(42),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, AcpError.AcpTransportError);
      assert.equal(error.pid, 42);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "ACP transport operation read-process-exit-status failed.");
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});

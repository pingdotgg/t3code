import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessExitError, WorkingCopyIndexLockedError } from "@t3tools/contracts";
import type * as VcsProcess from "../VcsProcess.ts";
import {
  INDEX_LOCK_BACKOFF_MS,
  INDEX_LOCK_MAX_ATTEMPTS,
  isIndexLockFailure,
  makeWorkingCopyGit,
  WORKING_COPY_MAX_OUTPUT_BYTES,
  type WorkingCopyExecutor,
} from "./WorkingCopyGit.ts";

const output = (overrides: Partial<VcsProcess.VcsProcessOutput>): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const LOCK_STDERR =
  "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository.";

/**
 * A recorded fake executor. Every assertion below is against `calls`, so the
 * retry sequence is a receipt rather than an inference from timing.
 */
const makeRecordingDriver = (respond: (attempt: number) => VcsProcess.VcsProcessOutput) => {
  const calls: Array<{
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly maxOutputBytes?: number;
  }> = [];
  const driver: WorkingCopyExecutor = {
    execute: (input) =>
      Effect.sync(() => {
        calls.push({
          args: input.args,
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
          ...(input.env !== undefined ? { env: input.env } : {}),
          ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
        });
        return respond(calls.length);
      }),
  };
  return { calls, driver };
};

describe("isIndexLockFailure", () => {
  it("recognises the contention message only on a failing exit", () => {
    assert.isTrue(isIndexLockFailure(output({ exitCode: 1 as never, stderr: LOCK_STDERR })));
    assert.isFalse(isIndexLockFailure(output({ stderr: LOCK_STDERR })));
    assert.isFalse(
      isIndexLockFailure(output({ exitCode: 1 as never, stderr: "fatal: pathspec mismatch" })),
    );
  });
});

describe("makeWorkingCopyGit", () => {
  it.effect("passes the 8 MiB output cap and the repository root to the driver", () =>
    Effect.gen(function* () {
      const { calls, driver } = makeRecordingDriver(() => output({}));

      yield* makeWorkingCopyGit(driver, "/repo").ok({ operation: "test", args: ["status"] });

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.maxOutputBytes, WORKING_COPY_MAX_OUTPUT_BYTES);
    }),
  );

  it.effect("forwards stdin, so a commit message never becomes argv", () =>
    Effect.gen(function* () {
      const { calls, driver } = makeRecordingDriver(() => output({}));

      yield* makeWorkingCopyGit(driver, "/repo").ok({
        operation: "test",
        args: ["commit", "-F", "-"],
        stdin: "subject\n\nbody\n",
      });

      assert.strictEqual(calls[0]?.stdin, "subject\n\nbody\n");
    }),
  );

  it.effect("forwards an isolated Git index environment", () =>
    Effect.gen(function* () {
      const { calls, driver } = makeRecordingDriver(() => output({}));
      const env = { ...process.env, GIT_INDEX_FILE: "/tmp/t3-commit-message-index" };

      yield* makeWorkingCopyGit(driver, "/repo").ok({
        operation: "test",
        args: ["add", "-A"],
        env,
      });

      assert.strictEqual(calls[0]?.env?.GIT_INDEX_FILE, "/tmp/t3-commit-message-index");
    }),
  );

  it.effect("fails with the full stderr as the error detail, not a canned string", () =>
    Effect.gen(function* () {
      const { driver } = makeRecordingDriver(() =>
        output({ exitCode: 1 as never, stderr: "error: line one\nerror: line two\n" }),
      );

      const failure = yield* makeWorkingCopyGit(driver, "/repo")
        .ok({ operation: "test", args: ["commit"] })
        .pipe(Effect.flip);

      assert.instanceOf(failure, VcsProcessExitError);
      assert.strictEqual(failure.detail, "error: line one\nerror: line two");
    }),
  );

  it.effect("does not retry a read, even when the lock is what failed", () =>
    Effect.gen(function* () {
      const { calls, driver } = makeRecordingDriver(() =>
        output({ exitCode: 1 as never, stderr: LOCK_STDERR }),
      );

      yield* makeWorkingCopyGit(driver, "/repo")
        .ok({ operation: "test", args: ["status"] })
        .pipe(Effect.flip);

      assert.strictEqual(calls.length, 1);
    }),
  );

  it.effect("does not retry a mutation that failed for any other reason", () =>
    Effect.gen(function* () {
      const { calls, driver } = makeRecordingDriver(() =>
        output({ exitCode: 1 as never, stderr: "fatal: pathspec 'x' did not match" }),
      );

      yield* makeWorkingCopyGit(driver, "/repo")
        .ok({ operation: "test", args: ["add"], mutating: true })
        .pipe(Effect.flip);

      assert.strictEqual(calls.length, 1);
    }),
  );

  it.effect("retries index.lock contention with a linear backoff and then succeeds", () =>
    Effect.gen(function* () {
      const { calls, driver } = makeRecordingDriver((attempt) =>
        attempt <= 2
          ? output({ exitCode: 1 as never, stderr: LOCK_STDERR })
          : output({ stdout: "done" }),
      );
      const git = makeWorkingCopyGit(driver, "/repo");

      const fiber = yield* Effect.forkChild(
        git.ok({ operation: "test", args: ["add"], mutating: true }),
      );

      // Backoff is 200 ms x attempt; nothing else moves the clock.
      yield* TestClock.adjust(Duration.millis(INDEX_LOCK_BACKOFF_MS));
      yield* TestClock.adjust(Duration.millis(INDEX_LOCK_BACKOFF_MS * 2));

      const result = yield* Fiber.join(fiber);

      assert.strictEqual(calls.length, 3);
      assert.strictEqual(result.stdout, "done");
    }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer()))),
  );

  it.effect("gives up after the documented attempt count with a distinct error", () =>
    Effect.gen(function* () {
      const { calls, driver } = makeRecordingDriver(() =>
        output({ exitCode: 1 as never, stderr: LOCK_STDERR }),
      );
      const git = makeWorkingCopyGit(driver, "/repo");

      const fiber = yield* Effect.forkChild(
        git
          .ok({ operation: "workingCopy.stagePaths", args: ["add"], mutating: true })
          .pipe(Effect.flip),
      );

      for (let attempt = 1; attempt < INDEX_LOCK_MAX_ATTEMPTS; attempt += 1) {
        yield* TestClock.adjust(Duration.millis(INDEX_LOCK_BACKOFF_MS * attempt));
      }

      const failure = yield* Fiber.join(fiber);

      assert.strictEqual(calls.length, INDEX_LOCK_MAX_ATTEMPTS);
      assert.instanceOf(failure, WorkingCopyIndexLockedError);
      assert.strictEqual(failure.attempts, INDEX_LOCK_MAX_ATTEMPTS);
      assert.strictEqual(failure.cwd, "/repo");
      assert.strictEqual(failure.operation, "workingCopy.stagePaths");
    }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer()))),
  );
});

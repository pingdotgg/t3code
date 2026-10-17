import { assert, describe, it } from "@effect/vitest";
import { GitCommandError, type GitCommandFailureReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { mapJjFailure } from "../jj/JjFailure.ts";
import * as ProcessRunner from "../processRunner.ts";
import { colocatedGitCommand, jjCommand } from "./JjProcess.ts";
import * as VcsProcess from "./VcsProcess.ts";

const encodeError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));
const cases: ReadonlyArray<readonly [string, GitCommandFailureReason | undefined]> = [
  [
    "Error: authentication failed for https://token:secret@example.com/repo",
    "authentication_failed",
  ],
  ["git@example.com: Permission denied (publickey).", "authentication_failed"],
  ["Host key verification failed.", "host_key_unverified"],
  ["fatal: Could not read from remote repository.", "remote_unreachable"],
  ["remote: authentication failed for secret", undefined],
  ["hook says authentication failed for secret", undefined],
  ["Error: unrelated failure for secret", undefined],
];

for (const command of ["jj", "git"] as const) {
  describe(`${command} failure reasons`, () => {
    for (const [stderr, reason] of cases) {
      it.effect(`classifies ${JSON.stringify(stderr)} without exposing diagnostics`, () =>
        Effect.gen(function* () {
          const process: VcsProcess.VcsProcess["Service"] = {
            run: () =>
              Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(1),
                stdout: "",
                stderr: command === "git" ? stderr.replace(/^Error:/, "error:") : stderr,
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          };
          const result =
            command === "jj"
              ? jjCommand(process, "fetch", "/repo", ["git", "fetch"])
              : colocatedGitCommand(process, "fetch", { gitDir: "/repo/.git", cwd: "/repo" }, [
                  "fetch",
                ]);
          const error = yield* result.pipe(
            mapJjFailure("fetch", "/repo", "Could not fetch."),
            Effect.flip,
          );
          assert.equal(error.reason, reason);
          const encoded = yield* encodeError(error);
          assert.notInclude(encoded, "secret");
          assert.notInclude(encoded, stderr);
        }),
      );
    }

    it.effect("preserves explicitly allowed nonzero exits", () =>
      Effect.gen(function* () {
        const process: VcsProcess.VcsProcess["Service"] = {
          run: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(1),
              stdout: "",
              stderr: "fatal: authentication failed",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        };
        const options = { allowNonZeroExit: true };
        const result = yield* command === "jj"
          ? jjCommand(process, "fetch", "/repo", ["git", "fetch"], options)
          : colocatedGitCommand(
              process,
              "fetch",
              { gitDir: "/repo/.git", cwd: "/repo" },
              ["fetch"],
              options,
            );
        assert.equal(result.exitCode, 1);
      }),
    );
  });
}

describe("jj process failure boundaries", () => {
  it.effect("keeps checkpoint retry policy in VcsProcess", () =>
    Effect.gen(function* () {
      const calls: VcsProcess.VcsProcessInput[] = [];
      const process: VcsProcess.VcsProcess["Service"] = {
        run: (input) => {
          calls.push(input);
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      };
      yield* colocatedGitCommand(
        process,
        VcsProcess.JJ_CHECKPOINT_CAPTURE_OPERATION,
        { gitDir: "/repo/.git", cwd: "/repo" },
        ["add", "-A"],
        { retryTransientFailures: true },
      );
      assert.equal(calls[0]?.allowNonZeroExit, false);
    }),
  );

  it.effect("retries transient checkpoint Git failures through the colocated command", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const process = yield* VcsProcess.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.sync(() => {
              attempts += 1;
              return {
                stdout: "",
                stderr:
                  attempts === 1 ? "fatal: Unable to create '/repo/index.lock': File exists" : "",
                code: ChildProcessSpawner.ExitCode(attempts === 1 ? 1 : 0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      );
      const fiber = yield* colocatedGitCommand(
        process,
        VcsProcess.JJ_CHECKPOINT_CAPTURE_OPERATION,
        { gitDir: "/repo/.git", cwd: "/repo" },
        ["add", "-A"],
        { retryTransientFailures: true },
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust("150 millis");
      const result = yield* Fiber.join(fiber);
      assert.equal(result.exitCode, 0);
      assert.equal(attempts, 2);
    }),
  );

  for (const [stderr, expectedKind] of [
    ["Error: Revision `missing` doesn't exist", "not-found"],
    ["Error: Function `trnk` doesn't exist", "command-failed"],
    ['Error: There is no jj repo in "/repo"', "command-failed"],
    ["Error: authentication failed", "authentication"],
  ] as const) {
    it.effect(`classifies changeAt failure ${JSON.stringify(stderr)}`, () =>
      Effect.gen(function* () {
        const process: VcsProcess.VcsProcess["Service"] = {
          run: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(1),
              stdout: "",
              stderr,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        };
        const error = yield* jjCommand(
          process,
          "arbitrary.read.operation",
          "/repo",
          ["log", "-r", "trnk()"],
          { readingChange: true },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "VcsProcessExitError");
        if (error._tag === "VcsProcessExitError") {
          assert.equal(error.failureKind, expectedKind);
        }
      }),
    );
  }
});

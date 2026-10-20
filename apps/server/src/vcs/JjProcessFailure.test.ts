import { assert, describe, it } from "@effect/vitest";
import {
  GitCommandError,
  VcsUnsupportedOperationError,
  type GitCommandFailureReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { jjFailure, mapJjFailure } from "../jj/JjFailure.ts";
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

it.effect("preserves nested unsupported detail instead of workspace wrapper messages", () =>
  Effect.gen(function* () {
    const detail = "Run `jj git colocation enable` in this repository.";
    const unsupported = new VcsUnsupportedOperationError({
      operation: "ensureUsable",
      kind: "jj",
      detail,
    });
    const nested = jjFailure("inner", "/repo", "Inner wrapper.", unsupported);
    const failure = jjFailure("outer", "/repo", "Outer wrapper.", nested);
    const codec = Schema.toCodecJson(GitCommandError);
    const wire = yield* Schema.encodeEffect(codec)(failure);
    const decoded = yield* Schema.decodeUnknownEffect(codec)(JSON.parse(JSON.stringify(wire)));
    assert.equal(decoded.reason, "unsupported_repository");
    assert.equal(decoded.detail, detail);
  }),
);

it("does not classify ordinary errors by their message", () => {
  const failure = jjFailure(
    "createWorktree",
    "/repo",
    "Could not create workspace.",
    new Error("VcsUnsupportedOperationError: Run jj git colocation enable"),
  );
  assert.isUndefined(failure.reason);
  assert.equal(failure.detail, "Could not create workspace.");
});

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

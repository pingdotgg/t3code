import { assert, describe, it } from "@effect/vitest";
import { GitCommandError, VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { JjProcessExitError } from "../vcs/JjProcess.ts";
import { jjFailure, mapJjFailure } from "./JjFailure.ts";

const encodeError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));

describe("jjFailure", () => {
  it("preserves structured reasons through nested jj and colocated Git failures", () => {
    for (const cause of [
      new GitCommandError({
        operation: "git.fetch",
        command: "git",
        cwd: "/repo",
        detail: "Git command failed.",
        reason: "host_key_unverified",
      }),
      new JjProcessExitError({
        ...new VcsProcessExitError({
          operation: "jj.fetch",
          command: "jj",
          cwd: "/repo",
          exitCode: 1,
          detail: "Command failed.",
        }),
        reason: "host_key_unverified",
      }),
    ]) {
      const inner = jjFailure("inner", "/repo", "Could not fetch.", cause);
      const outer = jjFailure("outer", "/repo", "Could not update repository.", inner);
      assert.equal(outer.reason, "host_key_unverified");
      assert.equal(outer.detail, "Could not update repository.");
      assert.equal(outer.cause, inner);
    }
  });

  it.effect("keeps raw diagnostics out of mapped errors", () =>
    Effect.gen(function* () {
      const secret = "https://token:super-secret@example.com/private.git";
      const cause = new JjProcessExitError({
        ...VcsProcessExitError.fromProcessExit(
          { operation: "fetch", command: "jj", cwd: "/repo", argumentCount: 2 },
          {
            exitCode: 1,
            stderr: `Error: authentication failed for ${secret}`,
            stderrTruncated: false,
          },
          "authentication",
        ),
        reason: "authentication_failed",
      });
      const error = yield* Effect.fail(cause).pipe(
        mapJjFailure("fetch", "/repo", "Could not fetch remote."),
        Effect.flip,
      );
      assert.equal(error.reason, "authentication_failed");
      assert.equal(error.detail, "Could not fetch remote.");
      assert.notInclude(yield* encodeError(error), secret);
    }),
  );

  it("does not infer a reason from arbitrary cause text", () => {
    const error = jjFailure(
      "fetch",
      "/repo",
      "Could not fetch.",
      new Error("authentication failed"),
    );
    assert.equal(error.reason, undefined);
    assert.equal(jjFailure("fetch", "/repo", "Could not fetch.").reason, undefined);
  });
});

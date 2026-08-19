import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PreparedWorktreeVerifier from "./PreparedWorktreeVerifier.ts";

const checkout = {
  repositoryRoot: process.cwd(),
  gitCommonDir: process.cwd(),
  worktreePath: process.cwd(),
  branch: "prepared",
  startingCommit: "abc123",
} as const;

function makeLayer(status = "") {
  const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) => {
    const command = input.args.join(" ");
    let stdout = "";
    let exitCode = 0;
    if (command === "rev-parse --show-toplevel") {
      stdout =
        input.cwd === checkout.repositoryRoot ? checkout.repositoryRoot : checkout.worktreePath;
    } else if (command === "rev-parse --path-format=absolute --git-common-dir") {
      stdout = checkout.gitCommonDir;
    } else if (command === "symbolic-ref --quiet --short HEAD") {
      stdout = checkout.branch;
    } else if (command === "rev-parse HEAD") {
      stdout = checkout.startingCommit;
    } else if (command === "status --porcelain=v1 -z") {
      stdout = status;
    } else if (command === "worktree list --porcelain -z") {
      stdout = [
        `worktree ${checkout.worktreePath}`,
        `HEAD ${checkout.startingCommit}`,
        `branch refs/heads/${checkout.branch}`,
        "",
      ].join("\0");
    } else {
      exitCode = 1;
    }
    return Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(exitCode),
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
  };
  return PreparedWorktreeVerifier.layer.pipe(
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute })),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("proves an exact clean registered worktree", () =>
  Effect.gen(function* () {
    const verifier = yield* PreparedWorktreeVerifier.PreparedWorktreeVerifier;
    assert.deepEqual(yield* verifier.verify(checkout, checkout.repositoryRoot), checkout);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("rejects a prepared worktree that became dirty", () =>
  Effect.gen(function* () {
    const verifier = yield* PreparedWorktreeVerifier.PreparedWorktreeVerifier;
    const failure = yield* Effect.flip(verifier.verify(checkout, checkout.repositoryRoot));
    assert.equal(failure.reason, "dirty_worktree");
  }).pipe(Effect.provide(makeLayer("?? changed.txt\0"))),
);

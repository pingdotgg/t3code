import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * Validate a model-generated full branch name with Git while preserving its spelling.
 * Internal temporary names and `refs/heads/` input are not valid user branch results.
 */
export const validateGeneratedBranchName = Effect.fn("validateGeneratedBranchName")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  rawBranch: string,
) {
  const branch = rawBranch.trim();
  if (
    branch.length === 0 ||
    branch.startsWith("-") ||
    branch.startsWith("refs/heads/") ||
    isTemporaryWorktreeBranch(branch)
  ) {
    return null;
  }

  const result = yield* git.execute({
    operation: "validateGeneratedBranchName",
    cwd,
    args: ["check-ref-format", "--branch", branch],
    allowNonZeroExit: true,
  });
  return result.exitCode === 0 && result.stdout.trim() === branch ? branch : null;
});

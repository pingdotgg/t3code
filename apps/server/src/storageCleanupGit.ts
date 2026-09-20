import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as GitManager from "./git/GitManager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

/** Resolve locally available evidence without fetching or guessing a branch name. */
export const resolveBaseRef = Effect.fn("StorageCleanup.resolveBaseRef")(function* (
  cwd: string,
  target?: { readonly url: string; readonly baseBranch: string },
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const primary = yield* git.resolvePrimaryRemoteName(cwd);
  if (!target) {
    const branch = yield* git.resolveDefaultBranchName(cwd, primary);
    if (branch !== null) return { remote: primary, branch };
  }
  const remotes = yield* git.execute({
    operation: "StorageCleanup.remotes",
    cwd,
    args: ["remote"],
  });
  if (remotes.stdoutTruncated) return null;
  const candidates: Array<{ remote: string; branch: string }> = [];
  const repository = target ? GitManager.pullRequestRepositoryKey(target.url) : null;
  if (target && repository === null) return null;
  for (const remote of remotes.stdout.trim().split("\n").filter(Boolean)) {
    if (target) {
      const url = yield* git.execute({
        operation: "StorageCleanup.remoteUrl",
        cwd,
        args: ["remote", "get-url", remote],
      });
      if (!url.stdoutTruncated && normalizeGitRemoteUrl(url.stdout) === repository) {
        return { remote, branch: target.baseBranch };
      }
    } else if (remote !== primary) {
      const branch = yield* git.resolveDefaultBranchName(cwd, remote);
      if (branch !== null) candidates.push({ remote, branch });
    }
  }
  // Several unrelated remotes with defaults are ambiguous without a PR target.
  return candidates.length === 1 ? candidates[0]! : null;
});

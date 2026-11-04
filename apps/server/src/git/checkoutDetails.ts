import * as Effect from "effect/Effect";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const readCheckoutDetails = Effect.fn("GitManager.readCheckoutDetails")(function* (
  cwd: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const read = (args: readonly string[]) =>
    git.execute({ operation: "GitManager.readCheckoutDetails", cwd, args, allowNonZeroExit: true });
  const head = yield* read(["log", "-1", "--format=%H%n%cI", "HEAD", "--"]);
  const [commit = "", committedAt = ""] = head.stdout.trim().split("\n");
  if (head.exitCode !== 0 || !commit) return undefined;
  const reflog = yield* read(["reflog", "-1", "--format=%gD", "--date=iso-strict", "HEAD"]);
  const origin = yield* read(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]);
  const originMainCommit = origin.exitCode === 0 ? origin.stdout.trim() : null;
  const behind = originMainCommit
    ? yield* read(["rev-list", "--count", `HEAD..${originMainCommit}`, "--"])
    : null;
  const count = behind?.exitCode === 0 ? Number(behind.stdout.trim()) : NaN;
  return {
    commit,
    committedAt,
    headUpdatedAt: /\{([^}]+)\}/.exec(reflog.stdout)?.[1] ?? null,
    originMainCommit,
    behindOriginMain: Number.isSafeInteger(count) && count >= 0 ? count : null,
  };
});

import type { VcsStatusResult } from "@t3tools/contracts";

export type ThreadPullRequestHeaderPill =
  | { readonly kind: "linked"; readonly number: number; readonly url: string }
  | { readonly kind: "create" }
  | { readonly kind: "hidden" };

/**
 * What the header's pull request control should be right now.
 *
 * The git actions button beside it answers "what moves my work forward", which is why it changes
 * label with every commit and push. This answers the question that outlives those: where the pull
 * request is, or that there is none yet. Splitting them is what stops one button meaning
 * "Commit & push" in the morning and "View PR" in the afternoon.
 *
 * Hidden is the answer when creating one would fail anyway. Offering it on a thread with nothing
 * committed, or behind its upstream, would put a button in the header whose only outcome is an
 * error toast.
 */
export function resolveThreadPullRequestHeaderPill(input: {
  /** The number the thread wears: an explicit link first, otherwise the one read off its branch. */
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly gitStatus: VcsStatusResult | null;
}): ThreadPullRequestHeaderPill {
  if (input.pullRequest !== null) {
    return { kind: "linked", number: input.pullRequest.number, url: input.pullRequest.url };
  }
  const gitStatus = input.gitStatus;
  if (gitStatus === null || gitStatus.refName === null) return { kind: "hidden" };
  // Mirrors the old menu's own create gate, so the pill appears exactly where "Create PR" used to
  // be offered and nowhere it was not.
  const canPushWithoutUpstream = gitStatus.hasPrimaryRemote && !gitStatus.hasUpstream;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canCreate =
    !gitStatus.hasWorkingTreeChanges &&
    gitStatus.pr?.state !== "open" &&
    hasDefaultBranchDelta &&
    gitStatus.behindCount === 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  return canCreate ? { kind: "create" } : { kind: "hidden" };
}

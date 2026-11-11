import {
  changeRequestTerminologyFor,
  type GitQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import type { VcsStatusResult } from "@t3tools/contracts";

import type { ThreadPr } from "../../state/thread-pr-presentation";

/** The checkout's open PR, else the thread's open linked PR; never feeds git action decisions. */
export function resolveThreadGitViewablePr(
  gitStatus: VcsStatusResult | null,
  linkedPullRequest: ThreadPr | null,
): ThreadPr | null {
  return gitStatus?.pr?.state === "open" ? gitStatus.pr : linkedPullRequest;
}

/** Own row when a viewable PR exists and the quick action is not already View PR. */
export function resolveThreadGitViewPrItem(
  gitStatus: VcsStatusResult | null,
  pr: ThreadPr | null,
  quickActionKind: GitQuickAction["kind"],
): { readonly title: string; readonly subtitle: string } | null {
  if (pr === null || quickActionKind === "open_pr") return null;
  const { shortLabel } = changeRequestTerminologyFor(gitStatus);
  return {
    title: `View ${shortLabel}`,
    subtitle: `${shortLabel} #${pr.number}`,
  };
}

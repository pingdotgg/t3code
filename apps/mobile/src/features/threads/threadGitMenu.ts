import {
  changeRequestTerminologyFor,
  type GitQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import type { VcsStatusResult } from "@t3tools/contracts";

/** Own row when an open PR exists and the quick action is already something else. */
export function resolveThreadGitViewPrItem(
  gitStatus: VcsStatusResult | null,
  quickActionKind: GitQuickAction["kind"],
): { readonly title: string; readonly subtitle: string } | null {
  const pr = gitStatus?.pr;
  if (pr?.state !== "open" || quickActionKind === "open_pr") return null;
  const { shortLabel } = changeRequestTerminologyFor(gitStatus);
  return {
    title: `View ${shortLabel}`,
    subtitle: `${shortLabel} #${pr.number}`,
  };
}

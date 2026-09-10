import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ExecutionEnvironmentCapabilities,
  ThreadPullRequestLink,
  VcsStatusResult,
} from "@t3tools/contracts";
import { resolveChangeRequestPresentation } from "@t3tools/shared/sourceControl";

import {
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";

export type ThreadPr = NonNullable<VcsStatusResult["pr"]>;

export interface ThreadPrPresentation {
  readonly number: number;
  readonly state: ThreadPr["state"] | null;
  readonly kind: "pull-request" | "stack";
  readonly others: number;
  readonly isDraft: boolean;
  /** Provider-side last activity, bounding when a terminal state landed. */
  readonly updatedAt: string | null;
  readonly url: string;
  /** Compact pull request number or linked count, e.g. "3774" or "+2". */
  readonly label: string;
  /** Full, provider-aware label for assistive technologies. */
  readonly accessibilityLabel: string;
  readonly textClassName: string;
}

const PR_STATE_TEXT_CLASS: Record<ThreadPr["state"], string> = {
  open: "text-adaptive-emerald-600-400",
  merged: "text-adaptive-violet-600-400",
  closed: "text-foreground-muted",
};

export function presentThreadPr(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): ThreadPrPresentation {
  const presentation = resolveChangeRequestPresentation(provider);
  const isDraft = pr.state === "open" && pr.isDraft === true;
  return {
    kind: "pull-request",
    others: 0,
    number: pr.number,
    state: pr.state,
    isDraft,
    updatedAt: pr.updatedAt ?? null,
    url: pr.url,
    label: String(pr.number),
    accessibilityLabel: `#${pr.number} ${presentation.longName} ${isDraft ? "draft" : pr.state}`,
    textClassName: isDraft ? "text-foreground-muted" : PR_STATE_TEXT_CLASS[pr.state],
  };
}

/** Persisted links render immediately, including links awaiting their first host sync. */
export function presentThreadLinkedPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ThreadPrPresentation | null {
  const link = resolveThreadCurrentPullRequestLink(links);
  const badge = resolveThreadPullRequestBadge(links);
  if (link === null || badge === null) return null;
  const snapshot = link.snapshot;
  const state = badge.kind === "stack" ? badge.state : (snapshot?.state ?? null);
  const isDraft = snapshot?.isDraft === true && state === "open";
  const label =
    badge.kind === "stack"
      ? String(badge.layers)
      : badge.others > 0
        ? `+${badge.others}`
        : String(link.number);
  return {
    kind: badge.kind,
    others: badge.kind === "pull-request" ? badge.others : 0,
    number: link.number,
    state,
    isDraft,
    updatedAt: snapshot?.updatedAt ?? null,
    url: link.url,
    label,
    accessibilityLabel:
      badge.kind === "stack"
        ? `${badge.layers} pull requests in stack, ${state ?? "status pending"}`
        : `#${link.number} pull request ${state === null ? "status pending" : isDraft ? "draft" : state}${badge.others > 0 ? `, ${badge.others} more linked` : ""}`,
    textClassName: state === null || isDraft ? "text-foreground-muted" : PR_STATE_TEXT_CLASS[state],
  };
}

/** Only the array capability replaces legacy references with persisted snapshots. */
export function resolveThreadPrSource(
  thread: Pick<EnvironmentThreadShell, "pullRequests" | "linkedPullRequest" | "branchPullRequest">,
  capabilities:
    | Pick<ExecutionEnvironmentCapabilities, "threadPullRequests" | "threadPullRequestLinking">
    | undefined,
) {
  const supportsSnapshots = capabilities?.threadPullRequests === true;
  const linkedPresentation = supportsSnapshots
    ? presentThreadLinkedPullRequests(thread.pullRequests)
    : null;
  const pullRequestRef =
    linkedPresentation !== null
      ? null
      : ((supportsSnapshots
          ? thread.branchPullRequest
          : (thread.linkedPullRequest ?? thread.branchPullRequest)) ?? null);
  return { linkedPresentation, pullRequestRef };
}

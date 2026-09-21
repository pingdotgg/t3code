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
  readonly inMergeQueue: boolean;
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
  const inMergeQueue = pr.state === "open" && pr.inMergeQueue === true;
  return {
    kind: "pull-request",
    others: 0,
    number: pr.number,
    state: pr.state,
    isDraft,
    inMergeQueue,
    updatedAt: pr.updatedAt ?? null,
    url: pr.url,
    label: String(pr.number),
    accessibilityLabel: `#${pr.number} ${presentation.longName} ${inMergeQueue ? "queued" : isDraft ? "draft" : pr.state}`,
    textClassName: inMergeQueue
      ? "text-adaptive-amber-600-400"
      : isDraft
        ? "text-foreground-muted"
        : PR_STATE_TEXT_CLASS[pr.state],
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
  const linkedCount = badge.kind === "pull-request" && badge.others > 0 ? badge.others + 1 : null;
  const isMultiple = badge.kind === "stack" || linkedCount !== null;
  const state = isMultiple
    ? badge.state === "draft" || badge.state === "queued"
      ? "open"
      : badge.state
    : (snapshot?.state ?? null);
  const isDraft = isMultiple
    ? badge.state === "draft"
    : snapshot?.isDraft === true && state === "open";
  const inMergeQueue = isMultiple
    ? badge.state === "queued"
    : snapshot?.inMergeQueue === true && state === "open";
  const label =
    badge.kind === "stack"
      ? String(badge.layers)
      : linkedCount !== null
        ? `+${linkedCount}`
        : String(link.number);
  return {
    kind: badge.kind,
    others: badge.kind === "pull-request" ? badge.others : 0,
    number: link.number,
    state,
    isDraft,
    inMergeQueue,
    updatedAt: snapshot?.updatedAt ?? null,
    url: link.url,
    label,
    accessibilityLabel:
      badge.kind === "stack"
        ? `${badge.layers} pull requests in stack, ${inMergeQueue ? "queued" : isDraft ? "draft" : (state ?? "status pending")}`
        : linkedCount !== null
          ? `${linkedCount} linked pull requests, overall ${badge.state}`
          : `#${link.number} pull request ${state === null ? "status pending" : inMergeQueue ? "queued" : isDraft ? "draft" : state}`,
    textClassName: inMergeQueue
      ? "text-adaptive-amber-600-400"
      : state === null || isDraft
        ? "text-foreground-muted"
        : isMultiple && state === "closed"
          ? "text-adaptive-rose-600-400"
          : PR_STATE_TEXT_CLASS[state],
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

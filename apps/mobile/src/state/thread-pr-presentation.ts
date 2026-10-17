import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ExecutionEnvironmentCapabilities,
  ThreadPullRequestLink,
  VcsStatusResult,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

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
  readonly updatedAt: string | null;
  readonly url: string;
  readonly label: string;
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
  const { changeRequest } = sourceControlClients.get(provider?.kind);
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
    accessibilityLabel: `#${pr.number} ${changeRequest.singular} ${isDraft ? "draft" : pr.state}`,
    textClassName: isDraft ? "text-foreground-muted" : PR_STATE_TEXT_CLASS[pr.state],
  };
}

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
    ? badge.state === "draft"
      ? "open"
      : badge.state
    : (snapshot?.state ?? null);
  const isDraft = isMultiple
    ? badge.state === "draft"
    : snapshot?.isDraft === true && state === "open";
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
    updatedAt: snapshot?.updatedAt ?? null,
    url: link.url,
    label,
    accessibilityLabel:
      badge.kind === "stack"
        ? `${badge.layers} pull requests in stack, ${isDraft ? "draft" : (state ?? "status pending")}`
        : linkedCount !== null
          ? `${linkedCount} linked pull requests, overall ${badge.state}`
          : `#${link.number} pull request ${state === null ? "status pending" : isDraft ? "draft" : state}`,
    textClassName:
      state === null || isDraft
        ? "text-foreground-muted"
        : isMultiple && state === "closed"
          ? "text-adaptive-rose-600-400"
          : PR_STATE_TEXT_CLASS[state],
  };
}

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

export function resolveThreadPrBadgeAction(pr: ThreadPrPresentation) {
  return pr.kind === "stack" || pr.others > 0
    ? { kind: "list" as const, accessibilityLabel: `Show ${pr.accessibilityLabel}` }
    : { kind: "open" as const, accessibilityLabel: `Open ${pr.accessibilityLabel}` };
}

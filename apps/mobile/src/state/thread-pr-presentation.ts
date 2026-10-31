import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  PullRequestSummary,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
  VcsStatusResult,
} from "@t3tools/contracts";
import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";

import {
  legacyThreadPullRequestKey,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestBadge,
  threadPullRequestKeyOf,
} from "@t3tools/client-runtime/thread-pull-requests";

export type ThreadPr = NonNullable<VcsStatusResult["pr"]>;

export interface ThreadPrPresentation {
  readonly number: number;
  readonly state: ThreadPr["state"] | null;
  readonly kind: "pull-request" | "stack";
  readonly others: number;
  readonly isDraft: boolean;
  readonly updatedAt: string | null;
  readonly url: string;
  readonly changeRequest: ChangeRequestTerminology;
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
    changeRequest,
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
  const { changeRequest } =
    sourceControlClients.findByChangeRequestUrl(link.url) ?? sourceControlClients.get(undefined);
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
    changeRequest,
    label,
    accessibilityLabel:
      badge.kind === "stack"
        ? `${badge.layers} ${changeRequest.singular}s in stack, ${isDraft ? "draft" : (state ?? "status pending")}`
        : linkedCount !== null
          ? `${linkedCount} linked ${changeRequest.plural}, overall ${badge.state}`
          : `#${link.number} ${changeRequest.singular} ${state === null ? "status pending" : isDraft ? "draft" : state}`,
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
  /** False until the server config loads; the stored references serve until then. */
  supportsSnapshots: boolean,
) {
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

/** Records `value` as the newest entry, evicting the least recently answered beyond `limit`. */
export function rememberBounded<V>(
  current: ReadonlyMap<string, V>,
  key: string,
  value: V,
  limit: number,
): ReadonlyMap<string, V> {
  const next = new Map(current);
  next.delete(key);
  next.set(key, value);
  for (const oldest of next.keys()) {
    if (next.size <= limit) break;
    next.delete(oldest);
  }
  return next;
}

/** The newest summary held for `pullRequest`, matched strictly by host, repository and number. */
export function knownPullRequestSummary(
  pullRequest: ThreadPullRequestKey,
  threads: Iterable<Pick<EnvironmentThreadShell, "projectId" | "pullRequests">>,
  summaries: Iterable<PullRequestSummary>,
): PullRequestSummary | undefined {
  const key = threadPullRequestKeyOf(pullRequest);
  let newest: PullRequestSummary | undefined;
  let newestReadAt: number | undefined;
  const consider = (summary: PullRequestSummary, readAt: number | undefined) => {
    const laterRead =
      summary.updatedAt === newest?.updatedAt &&
      readAt !== undefined &&
      newestReadAt !== undefined &&
      readAt > newestReadAt;
    if (newest === undefined || summary.updatedAt > newest.updatedAt || laterRead) {
      newest = summary;
      newestReadAt = readAt;
    }
  };
  for (const summary of summaries) {
    if (threadPullRequestKeyOf(legacyThreadPullRequestKey(summary)) === key) {
      consider(summary, summary.observedAt);
    }
  }
  for (const thread of threads) {
    for (const link of thread.pullRequests) {
      const snapshot = link.snapshot;
      if (snapshot?.updatedAt == null || threadPullRequestKeyOf(link) !== key) continue;
      consider(
        {
          ...snapshot,
          updatedAt: snapshot.updatedAt,
          provider: (
            sourceControlClients.findByChangeRequestUrl(link.url) ??
            sourceControlClients.get(undefined)
          ).kind,
          projectId: thread.projectId,
          repository: link.repository,
          number: link.number,
          url: link.url,
        },
        Date.parse(snapshot.syncedAt),
      );
    }
  }
  return newest;
}

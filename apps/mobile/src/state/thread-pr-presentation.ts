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
import { changeRequestTermKind } from "../lib/changeRequestTerm";

import {
  legacyThreadPullRequestKey,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestBadge,
  threadPullRequestKeyOf,
} from "@t3tools/client-runtime/thread-pull-requests";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";

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
  closed: "text-adaptive-rose-600-400",
};

function prStateKey(state: ThreadPr["state"] | "draft" | null) {
  return state ?? "pending";
}

/** Render callers pass `useMessages()` so the label follows a language switch. */
export function presentThreadPr(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
  resolve: MessageResolver = m,
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
    accessibilityLabel: resolve(
      msg(
        "{term, select, mr {#{number} merge request {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} cr {#{number} change request {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} other {#{number} pull request {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}}}",
        {
          number: String(pr.number),
          term: changeRequestTermKind(changeRequest),
          state: prStateKey(isDraft ? "draft" : pr.state),
        },
      ),
    ),
    textClassName: isDraft ? "text-foreground-muted" : PR_STATE_TEXT_CLASS[pr.state],
  };
}

export function presentThreadLinkedPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
  resolve: MessageResolver = m,
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
        ? resolve(
            msg(
              "{term, select, mr {{count, plural, one {{count} merge requests in stack, {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} other {{count} merge requests in stack, {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}}}} cr {{count, plural, one {{count} change requests in stack, {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} other {{count} change requests in stack, {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}}}} other {{count, plural, one {{count} pull requests in stack, {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} other {{count} pull requests in stack, {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}}}}}",
              {
                count: badge.layers,
                term: changeRequestTermKind(changeRequest),
                state: prStateKey(isDraft ? "draft" : state),
              },
            ),
          )
        : linkedCount !== null
          ? resolve(
              msg(
                "{term, select, mr {{count, plural, one {{count} linked merge requests, overall {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} other {{count} linked merge requests, overall {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}}}} cr {{count, plural, one {{count} linked change requests, overall {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} other {{count} linked change requests, overall {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}}}} other {{count, plural, one {{count} linked pull requests, overall {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} other {{count} linked pull requests, overall {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}}}}}",
                {
                  count: linkedCount,
                  term: changeRequestTermKind(changeRequest),
                  state: prStateKey(badge.state),
                },
              ),
            )
          : resolve(
              msg(
                "{term, select, mr {#{number} merge request {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} cr {#{number} change request {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}} other {#{number} pull request {state, select, pending {status pending} draft {draft} open {open} merged {merged} other {closed}}}}",
                {
                  number: String(link.number),
                  term: changeRequestTermKind(changeRequest),
                  state: prStateKey(state === null ? null : isDraft ? "draft" : state),
                },
              ),
            ),
    textClassName: state === null || isDraft ? "text-foreground-muted" : PR_STATE_TEXT_CLASS[state],
  };
}

export function resolveThreadPrSource(
  thread: Pick<EnvironmentThreadShell, "pullRequests" | "linkedPullRequest" | "branchPullRequest">,
  /** False until the server config loads; the stored references serve until then. */
  supportsSnapshots: boolean,
  resolve: MessageResolver = m,
) {
  const linkedPresentation = supportsSnapshots
    ? presentThreadLinkedPullRequests(thread.pullRequests, resolve)
    : null;
  const pullRequestRef =
    linkedPresentation !== null
      ? null
      : ((supportsSnapshots
          ? thread.branchPullRequest
          : (thread.linkedPullRequest ?? thread.branchPullRequest)) ?? null);
  return { linkedPresentation, pullRequestRef };
}

export function resolveThreadPrBadgeAction(pr: ThreadPrPresentation, resolve: MessageResolver = m) {
  return pr.kind === "stack" || pr.others > 0
    ? {
        kind: "list" as const,
        accessibilityLabel: resolve(msg("Show {label}", { label: pr.accessibilityLabel })),
      }
    : {
        kind: "open" as const,
        accessibilityLabel: resolve(msg("Open {label}", { label: pr.accessibilityLabel })),
      };
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
  let newest:
    | { readonly summary: PullRequestSummary; readonly updatedAt: number; readonly readAt: number }
    | undefined;
  // Checks and reviews change without moving `updatedAt`, so equal versions prefer the later read.
  const consider = (summary: PullRequestSummary, readAt = Number.NEGATIVE_INFINITY) => {
    const updatedAt = Date.parse(summary.updatedAt);
    if (
      newest === undefined ||
      updatedAt > newest.updatedAt ||
      (updatedAt === newest.updatedAt && readAt > newest.readAt)
    ) {
      newest = { summary, updatedAt, readAt };
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
  return newest?.summary;
}

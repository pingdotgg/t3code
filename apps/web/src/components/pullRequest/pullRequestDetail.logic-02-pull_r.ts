import type { PullRequestConversationItem, PullRequestReviewOutcome, PullRequestReviewOutcomeEntry, PullRequestTimelineEvent, PullRequestTimelineRow, ThreadPanelPullRequestAction } from "./pullRequestDetail.logic-03-thread.ts";
import {
  capitalizeTerm,
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import {
  GitCommandError,
  PullRequestDetail,
  PullRequestOperationError,
  type PullRequestAction,
  type PullRequestActor,
  type PullRequestBaseComparison,
  type PullRequestCheck,
  type PullRequestChecksState as ContractPullRequestChecksState,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestContextMetadata,
  type PullRequestDetailView,
  type PullRequestMergeability,
  type PullRequestReaction,
  type PullRequestMergeMethod,
  type PullRequestRef,
  type RepositoryIdentity,
  type PullRequestReviewThread,
  type PullRequestState,
  type PullRequestUpdateMethod,
  SourceControlProviderKind,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type VcsRef,
} from "@t3tools/contracts";
import {
  legacyThreadPullRequestKey,
  resolveThreadCurrentPullRequestLink,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";

export const PULL_REQUEST_MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export function allowsSinglePullRequestMerge(input: {
  supportsStackActions: boolean;
  hasStack: boolean;
  stackPending: boolean;
  stackError: string | null;
}): boolean {
  return (
    !input.supportsStackActions ||
    (!input.hasStack && !input.stackPending && input.stackError === null)
  );
}

export function resolvePullRequestMergeMethod(
  allowed: ReadonlyArray<PullRequestMergeMethod>,
  current: PullRequestMergeMethod | null,
  projectDefault: PullRequestMergeMethod | undefined,
  lastSelected: PullRequestMergeMethod,
): PullRequestMergeMethod {
  for (const method of [current, projectDefault, lastSelected]) {
    if (method && allowed.includes(method)) return method;
  }
  return allowed[0] ?? "merge";
}

export type PullRequestPrimaryControl =
  | "resolve"
  | "ready"
  | "merge"
  | "enable-auto-merge"
  | "auto-merge-armed"
  | "merged"
  | "closed"
  | null;

export function resolvePullRequestPrimaryControl(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly checksState: ContractPullRequestChecksState | null;
  readonly autoMergeEnabled: boolean | undefined;
  readonly hasMergeMethod: boolean;
  readonly canMerge: boolean;
  readonly canMarkReady: boolean;
  readonly canEnableAutoMerge: boolean;
}): PullRequestPrimaryControl {
  if (input.state === "merged") return "merged";
  if (input.state === "closed") return "closed";
  if (input.mergeability === "conflicting") return "resolve";
  if (input.isDraft) return input.canMarkReady ? "ready" : null;
  if (input.autoMergeEnabled) return "auto-merge-armed";
  if (!input.hasMergeMethod) return null;
  if (
    input.autoMergeEnabled === false &&
    input.checksState !== null &&
    input.checksState !== "passing" &&
    input.canEnableAutoMerge
  ) {
    return "enable-auto-merge";
  }
  return input.canMerge ? "merge" : null;
}

export function pullRequestCheckoutCommand(
  provider: SourceControlProviderKind,
  number: number,
  headBranch: string,
  headRepositoryNameWithOwner?: string | null,
  repositoryUrl?: string | null,
): string | null {
  return sourceControlClients
    .get(provider)
    .checkoutCommand({ number, headBranch, headRepositoryNameWithOwner, repositoryUrl });
}

export function loadingPullRequestCheckoutCommand(
  reference: PullRequestRef,
  identity: RepositoryIdentity | null | undefined,
): string | null {
  const host = reference.host?.trim().toLowerCase();
  const definition = identity?.provider
    ? sourceControlClients.find(identity.provider)
    : host
      ? sourceControlClients.findByPublicHost(host)
      : undefined;
  const command = definition?.checkoutCommand({ number: reference.number, headBranch: "" });
  if (!definition || !command) return null;
  if (
    identity?.provider !== undefined &&
    host &&
    sourceControlClients.changeRequestHost(identity, definition.kind) !== host
  ) {
    return null;
  }
  return command;
}

export function shouldRefreshPullRequestActivity(
  previous: { readonly key: string; readonly updatedAt: string } | null,
  next: { readonly key: string; readonly updatedAt: string },
): boolean {
  return previous !== null && previous.key === next.key && previous.updatedAt !== next.updatedAt;
}
export function mergePullRequestThreadComments<T extends { readonly id: string }>(
  base: ReadonlyArray<T>,
  loaded: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const seen = new Set(base.map((comment) => comment.id));
  return [
    ...base,
    ...loaded.filter((comment) => {
      if (seen.has(comment.id)) return false;
      seen.add(comment.id);
      return true;
    }),
  ];
}

export function editPullRequestThreadComment<
  T extends { readonly id: string; readonly body: string },
>(comments: ReadonlyArray<T>, commentId: string, body: string): ReadonlyArray<T> {
  return comments.map((comment) => (comment.id === commentId ? { ...comment, body } : comment));
}

export type LegacyLinkedPullRequest = Pick<ThreadLinkedPullRequest, "repository" | "number">;

/** Include every stack link and project identity; another checkout is a different branch. */
export function pullRequestPanelContext(
  thread: {
    readonly projectId: string | null;
    readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
    readonly linkedPullRequest?: LegacyLinkedPullRequest | null | undefined;
    readonly branchPullRequest?: LegacyLinkedPullRequest | null | undefined;
  },
  surface: {
    readonly projectId: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  },
): "page" | "thread" {
  if (thread.projectId !== surface.projectId) return "page";
  const links = visibleThreadPullRequests(thread.pullRequests ?? []);
  if (links.length > 0) {
    const repository = surface.repository.toLowerCase();
    return links.some((link) =>
      surface.host !== undefined
        ? threadPullRequestKeysEqual(link, {
            host: surface.host,
            repository: surface.repository,
            number: surface.number,
          })
        : link.number === surface.number && link.repository.toLowerCase() === repository,
    )
      ? "thread"
      : "page";
  }
  const legacy = thread.linkedPullRequest ?? thread.branchPullRequest ?? null;
  return legacy !== null &&
    legacy.repository === surface.repository &&
    legacy.number === surface.number
    ? "thread"
    : "page";
}

export function threadPullRequestPanelTarget(thread: {
  readonly projectId: string;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}) {
  const current = resolveThreadCurrentPullRequestLink(thread.pullRequests ?? []);
  const legacy = thread.linkedPullRequest;
  if (
    current !== null &&
    legacy != null &&
    threadPullRequestKeysEqual(current, legacyThreadPullRequestKey(legacy))
  ) {
    return legacy;
  }
  if (current !== null) {
    return {
      projectId: thread.projectId,
      host: current.host,
      repository: current.repository,
      number: current.number,
      url: current.url,
    };
  }
  return legacy ?? thread.branchPullRequest ?? null;
}

export function pullRequestHandoffLabels(inThisThread: boolean) {
  return inThisThread
    ? {
        fixFinding: "Fix in this thread",
        fixCheck: "Fix in this thread",
        fixFindings: "Fix findings in this thread",
      }
    : {
        fixFinding: "Fix in a thread",
        fixCheck: "Fix",
        fixFindings: "Fix findings in a thread",
      };
}

export function pullRequestActionMenuHasGroup(
  showsDraftToggle: boolean,
  showsAutoMerge: boolean,
  showsMergeMethods: boolean,
): boolean {
  return showsDraftToggle || showsAutoMerge || showsMergeMethods;
}

export function isStackedPullRequestBase(
  baseBranch: string,
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "isRemote" | "remoteName">>,
): boolean {
  const defaultRef = refs.find((refName) => refName.isDefault);
  if (!defaultRef) return false;
  if (defaultRef.isRemote !== true) return defaultRef.name !== baseBranch;
  const remotePrefix = `${defaultRef.remoteName ?? defaultRef.name.split("/")[0]}/`;
  const defaultBranch = defaultRef.name.startsWith(remotePrefix)
    ? defaultRef.name.slice(remotePrefix.length)
    : defaultRef.name;
  return defaultBranch !== baseBranch;
}

export type PullRequestActionableDetail = Pick<
  PullRequestDetail,
  "state" | "isDraft" | "mergeability" | "capabilities" | "viewerPermissions" | "mergeCapabilities"
>;

export function allowedPullRequestMergeMethods(
  detail: Pick<PullRequestActionableDetail, "capabilities" | "mergeCapabilities"> | null,
): ReadonlyArray<PullRequestMergeMethod> {
  return detail === null
    ? []
    : detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method]);
}

export function canPerformPullRequestAction(
  detail: Pick<PullRequestActionableDetail, "capabilities" | "viewerPermissions"> | null,
  action: PullRequestAction,
): boolean {
  return (
    detail !== null &&
    detail.capabilities.actions.includes(action) &&
    detail.viewerPermissions.actions.includes(action)
  );
}

export function isPullRequestConflicting(
  detail: Pick<PullRequestActionableDetail, "state" | "mergeability"> | null,
): boolean {
  return detail?.state === "open" && detail.mergeability === "conflicting";
}

export type PullRequestChecksState = "none" | "pending" | "failing" | "passing";

export function classifyPullRequestChecks(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState {
  if (checks.length === 0) return "none";
  if (checks.some((check) => check.status === "failure" || check.status === "cancelled")) {
    return "failing";
  }
  if (checks.some((check) => check.status === "pending" || check.status === "action-required")) {
    return "pending";
  }
  return "passing";
}

export function describePullRequestChecks(checks: ReadonlyArray<PullRequestCheck>): string {
  if (checks.length === 0) return "No checks reported";
  const failed = checks.filter(
    (check) => check.status === "failure" || check.status === "cancelled",
  ).length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const actionRequired = checks.filter((check) => check.status === "action-required").length;
  const passed = checks.filter((check) => check.status === "success").length;
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} of ${checks.length} running`);
  if (actionRequired > 0) parts.push(`${actionRequired} of ${checks.length} awaiting action`);
  if (failed > 0) {
    parts.push(parts.length > 0 ? `${failed} failed` : `${failed} of ${checks.length} failing`);
  }
  if (parts.length === 0) {
    return passed === checks.length ? "All checks passed" : `${passed} of ${checks.length} passing`;
  }
  return parts.join(" · ");
}

export function groupPullRequestChecks(checks: ReadonlyArray<PullRequestCheck>) {
  return {
    attention: checks.filter((check) =>
      ["failure", "cancelled", "action-required"].includes(check.status),
    ),
    running: checks.filter((check) => check.status === "pending"),
    completed: checks.filter((check) => ["success", "skipped", "neutral"].includes(check.status)),
  };
}

export function resolveThreadPanelPullRequestAction(
  detail: (PullRequestActionableDetail & Pick<PullRequestDetail, "checks">) | null,
): ThreadPanelPullRequestAction | null {
  if (detail === null || detail.state !== "open") return null;
  if (isPullRequestConflicting(detail)) return "resolve";
  if (detail.isDraft) {
    return canPerformPullRequestAction(detail, "ready") ? "ready" : null;
  }
  const checks = classifyPullRequestChecks(detail.checks);
  if (checks === "failing") return "fix";
  if (checks === "pending") return null;
  return canPerformPullRequestAction(detail, "merge") &&
    allowedPullRequestMergeMethods(detail).length > 0
    ? "merge"
    : null;
}

export function orderPullRequestComments<T extends { readonly createdAt: string }>(
  comments: ReadonlyArray<T>,
  order: "newest" | "oldest",
): ReadonlyArray<T> {
  return order === "newest" ? comments.toReversed() : comments;
}

export function pullRequestReviewOutcome(
  reviewState: string | null,
): PullRequestReviewOutcome | null {
  switch (reviewState?.trim().toLowerCase().replaceAll("_", "-")) {
    case "approved":
      return "approved";
    case "changes-requested":
      return "changes-requested";
    case "dismissed":
      return "dismissed";
    default:
      return null;
  }
}

// Host UTC offsets make lexical timestamp sorting unsafe.
export function instant(iso: string): number {
  return Date.parse(iso);
}

export function newestPullRequestCommitAt(
  commits: ReadonlyArray<PullRequestCommit>,
): string | null {
  let newest: string | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const commit of commits) {
    const at = instant(commit.committedDate);
    if (Number.isNaN(at) || at <= newestAt) continue;
    newest = commit.committedDate;
    newestAt = at;
  }
  return newest;
}

export function isPullRequestVerdictStale(at: string, newestCommitAt: string | null): boolean {
  if (newestCommitAt === null) return false;
  const verdictAt = instant(at);
  const commitAt = instant(newestCommitAt);
  return !Number.isNaN(verdictAt) && !Number.isNaN(commitAt) && verdictAt < commitAt;
}

export function latestPullRequestReviewOutcomes(
  comments: ReadonlyArray<PullRequestComment>,
  commits: ReadonlyArray<PullRequestCommit> = [],
): ReadonlyArray<PullRequestReviewOutcomeEntry> {
  const newestCommitAt = newestPullRequestCommitAt(commits);
  const latest = new Map<string, PullRequestReviewOutcomeEntry>();
  for (const comment of comments) {
    const outcome = pullRequestReviewOutcome(comment.reviewState);
    if (outcome === null) continue;
    const login = comment.author?.login ?? `ghost:${comment.id}`;
    const current = latest.get(login);
    // Hosts can return reviews out of order.
    if (current !== undefined && instant(current.at) > instant(comment.createdAt)) continue;
    latest.set(login, {
      key: login,
      actor: comment.author,
      outcome,
      at: comment.createdAt,
      stale: isPullRequestVerdictStale(comment.createdAt, newestCommitAt),
    });
  }
  return [...latest.values()].filter((entry) => entry.outcome !== "dismissed");
}

export function groupPullRequestTimelineConversations(
  events: ReadonlyArray<PullRequestTimelineEvent>,
): ReadonlyArray<PullRequestTimelineRow> {
  const rows: PullRequestTimelineRow[] = [];
  for (const event of events) {
    if (
      (event.kind === "comment" || event.kind === "review") &&
      event.thread === undefined &&
      pullRequestReviewOutcome(event.reviewState) === null
    ) {
      const last = rows.at(-1);
      if (last?.kind === "comments") {
        rows[rows.length - 1] = { kind: "comments", events: [...last.events, event] };
      } else {
        rows.push({ kind: "comments", events: [event] });
      }
    } else {
      rows.push({ kind: "event", event });
    }
  }
  return rows;
}

/** Marker-only bodies are empty; otherwise retain text, including fenced HTML comments. */
export function visibleBody(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length === 0 ? null : body.trim();
}

export function commentTimelineEvent(comment: PullRequestComment): PullRequestTimelineEvent {
  return {
    comment,
    id: comment.id,
    at: comment.createdAt,
    kind: comment.kind === "review" ? "review" : "comment",
    title: comment.kind === "review" ? "reviewed" : "commented",
    body: visibleBody(comment.body),
    markdown: true,
    url: comment.url,
    actor: comment.author,
    commitAuthors: [],
    additions: null,
    deletions: null,
    path: comment.path,
    reviewState: comment.reviewState,
    reactions: comment.reactions ?? [],
  };
}

export function pullRequestConversationItems(
  comments: ReadonlyArray<PullRequestComment>,
  reviewThreads: ReadonlyArray<PullRequestReviewThread>,
): ReadonlyArray<PullRequestConversationItem> {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const claimed = new Set<string>();
  const threads: PullRequestConversationItem[] = [];
  for (const thread of reviewThreads) {
    // Keep the conversation's objects for editing/reactions; some hosts only include a
    // comment in the thread, so normalize that copy when the flat conversation lacks it.
    const ordered = thread.comments
      .map(
        (comment): PullRequestComment =>
          byId.get(comment.id) ?? {
            ...comment,
            kind: "review-comment",
            path: thread.path,
            reviewState: null,
          },
      )
      .toSorted((left, right) => instant(left.createdAt) - instant(right.createdAt));
    const [root, ...replies] = ordered;
    if (root === undefined) continue;
    for (const comment of ordered) claimed.add(comment.id);
    const moreReplies = Math.max(0, (thread.commentCount ?? ordered.length) - ordered.length);
    threads.push({
      kind: "thread",
      id: thread.id,
      createdAt: root.createdAt,
      root,
      replies,
      thread,
      moreReplies,
      hasMoreReplies: moreReplies > 0 || thread.nextCommentsCursor !== undefined,
      url: ordered.find((comment) => comment.url !== null)?.url ?? null,
    });
  }
  threads.sort((left, right) => instant(left.createdAt) - instant(right.createdAt));
  const items: PullRequestConversationItem[] = [];
  let next = 0;
  // Preserve loose comments' existing order, inserting each thread at its finding's time.
  for (const comment of comments) {
    if (claimed.has(comment.id)) continue;
    while (
      next < threads.length &&
      instant(threads[next]!.createdAt) < instant(comment.createdAt)
    ) {
      items.push(threads[next++]!);
    }
    items.push({ kind: "comment", id: comment.id, createdAt: comment.createdAt, comment });
  }
  items.push(...threads.slice(next));
  return items;
}

export function pullRequestConversationItemComments(
  item: PullRequestConversationItem,
): ReadonlyArray<PullRequestComment> {
  return item.kind === "comment" ? [item.comment] : [item.root, ...item.replies];
}

export function isPullRequestCommentFinished(
  comment: PullRequestComment,
  thread?: PullRequestReviewThread,
): boolean {
  return (
    thread?.isResolved === true || pullRequestReviewOutcome(comment.reviewState) === "dismissed"
  );
}

export function isPullRequestVerdict(reviewState: string | null): boolean {
  const outcome = pullRequestReviewOutcome(reviewState);
  return outcome === "approved" || outcome === "changes-requested";
}

export function filterPullRequestConversationItems(
  items: ReadonlyArray<PullRequestConversationItem>,
  filter: { readonly bots: boolean; readonly resolved: boolean },
): ReadonlyArray<PullRequestConversationItem> {
  return items.filter((item) =>
    // Matching any member keeps the finding beside a human reply to a bot.
    pullRequestConversationItemComments(item).some(
      (comment) =>
        // A bot's approval or change request is a verdict, not chatter.
        (filter.bots ||
          comment.author?.isBot !== true ||
          isPullRequestVerdict(comment.reviewState)) &&
        (filter.resolved ||
          !isPullRequestCommentFinished(comment, item.kind === "thread" ? item.thread : undefined)),
    ),
  );
}

export function pagePullRequestConversationItems(
  items: ReadonlyArray<PullRequestConversationItem>,
  count: number,
): { readonly shown: ReadonlyArray<PullRequestConversationItem>; readonly hidden: number } {
  const shown = items.slice(Math.max(0, items.length - count));
  return { shown, hidden: items.length - shown.length };
}

/**
 * Merged wins over closed: GitHub sets both timestamps on a merge, and reporting "closed" for a
 * merged pull request would misstate what happened.
 */
export function buildPullRequestTimeline(
  detail: Pick<
    PullRequestDetailView,
    "provider" | "createdAt" | "author" | "commits" | "comments" | "mergedAt" | "closedAt"
  > &
    Partial<Pick<PullRequestDetailView, "reviewThreads">>,
): ReadonlyArray<PullRequestTimelineEvent> {
  const term = sourceControlClients.get(detail.provider).changeRequest.singular;
  return [
    {
      id: "created",
      at: detail.createdAt,
      kind: "opened" as const,
      title: `opened this ${term}`,
      body: null,
      markdown: false,
      url: null,
      actor: detail.author,
      commitAuthors: [],
      additions: null,
      deletions: null,
      path: null,
      reviewState: null,
      reactions: [],
    },
    ...detail.commits.map((commit) => ({
      id: commit.oid,
      at: commit.committedDate,
      kind: "commit" as const,
      title: `Commit ${commit.oid.slice(0, 7)}`,
      body: commit.messageHeadline || null,
      markdown: false,
      url: null,
      actor: commit.authors?.[0] ?? null,
      commitAuthors: commit.authors ?? [],
      additions: commit.additions ?? null,
      deletions: commit.deletions ?? null,
      path: null,
      reviewState: null,
      reactions: [],
    })),
    ...pullRequestConversationItems(detail.comments, detail.reviewThreads ?? []).map((item) => {
      if (item.kind === "comment") return commentTimelineEvent(item.comment);
      return {
        ...commentTimelineEvent(item.root),
        thread: {
          path: item.thread.path,
          line: item.thread.line,
          isResolved: item.thread.isResolved,
          isOutdated: item.thread.isOutdated,
          replies: item.replies.map(commentTimelineEvent),
          moreReplies: item.moreReplies,
          hasMoreReplies: item.hasMoreReplies,
          url: item.url,
        },
      };
    }),
    ...(detail.mergedAt
      ? [
          {
            id: "merged",
            at: detail.mergedAt,
            kind: "merged" as const,
            title: `${capitalizeTerm(term)} merged`,
            body: null,
            markdown: false,
            url: null,
            actor: null,
            commitAuthors: [],
            additions: null,
            deletions: null,
            path: null,
            reviewState: null,
            reactions: [],
          },
        ]
      : []),
    ...(detail.closedAt && !detail.mergedAt
      ? [
          {
            id: "closed",
            at: detail.closedAt,
            kind: "closed" as const,
            title: `${capitalizeTerm(term)} closed`,
            body: null,
            markdown: false,
            url: null,
            actor: null,
            commitAuthors: [],
            additions: null,
            deletions: null,
            path: null,
            reviewState: null,
            reactions: [],
          },
        ]
      : []),
  ].toSorted((left, right) => (instant(right.at) || 0) - (instant(left.at) || 0));
}


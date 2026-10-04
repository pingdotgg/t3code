import type {
  CommandId,
  GitPullRequestAssociation,
  OrchestrationReadModel,
  OrchestrationThread,
  PullRequestRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  threadPullRequestIdentity,
  threadPullRequestKey,
} from "@t3tools/shared/threadPullRequests";

import { pullRequestFromReviewSnapshot } from "../orchestration/reviewPullRequest.ts";
import { collectActiveThreadSubtree } from "../orchestration/threadHierarchy.ts";
import { isReviewWorkflowThread } from "./reviewWorkflowThread.ts";

export type ReviewThreadMergeArchiveCandidate = {
  readonly threadId: ThreadId;
  readonly pullRequestKey: string;
};

/** `ref` is what the provider is asked about; the keys are how the read model names it. */
export type ReviewThreadPullRequest = {
  readonly ref: PullRequestRef;
  readonly pullRequestKeys: ReadonlyArray<string>;
  readonly recordedState: "merged" | "unmerged";
};

/**
 * A review worker created after 8ba0d1103e records `pullRequest: null` to keep
 * `CreatedPullRequestReviewReactor` from reviewing the PR it is reviewing, which
 * leaves it with no link at all. Its immutable review snapshot is still explicit
 * PR provenance — the same authority migrations 067/068 give it — so fall back to
 * that before concluding the thread is not watching a pull request.
 */
export function reviewThreadPullRequests(
  thread: Pick<OrchestrationThread, "pullRequests" | "pullRequest" | "reviewSnapshot">,
): ReadonlyArray<GitPullRequestAssociation> {
  const linked = (thread.pullRequests ?? []).map((link) => link.pullRequest);
  const legacy = thread.pullRequest;
  const associated = legacy === null || legacy === undefined ? linked : [...linked, legacy];
  // Safe to append unconditionally: `liveReviewThreadPullRequests` keys by pull
  // request ref and dedupes keys, so a link naming the same PR costs nothing.
  const fromSnapshot = pullRequestFromReviewSnapshot(thread.reviewSnapshot);
  return fromSnapshot === undefined ? associated : [...associated, fromSnapshot];
}

// Shared by the sweep's plan and the admission guard so the two cannot drift.
export function canAutoArchiveThreadNow(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): boolean {
  const thread = readModel.threads.find((entry) => entry.id === threadId);
  if (thread === undefined || !isArchiveCandidate(thread)) return false;
  if (!isReviewWorkflowThread(thread)) return false;
  if (reviewThreadPullRequests(thread).length === 0) return false;
  return !subtreeHasRunningTurn(readModel, threadId);
}

// Admission guard registered on the AutomaticArchiveGuardRegistry. Unsettled
// threads are checked exactly as `canAutoArchiveThreadNow`; settled threads
// are abstained on (approved) because the settled auto-archiver owns them: the
// merge sweep never dispatches a settled thread (`activeReviewRoots` excludes
// them, and the plan re-reads the model after provider reads), while the
// settled guard re-checks candidacy and due-ness at admission. Returning false
// here would veto every settled auto-archive under the registry's
// every-guard-must-approve rule.
export function canAdmitAutomaticArchiveNow(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): boolean {
  const thread = readModel.threads.find((entry) => entry.id === threadId);
  if (thread !== undefined && (thread.settledOverride ?? null) === "settled") return true;
  return canAutoArchiveThreadNow(readModel, threadId);
}

function isArchiveCandidate(thread: OrchestrationThread): boolean {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
  // Settling is a deliberate signal from the user; archiving would overwrite it.
  if (thread.settledOverride === "settled") return false;
  return !hasRunningTurn(thread);
}

function hasRunningTurn(thread: OrchestrationThread): boolean {
  return thread.latestTurn?.state === "running";
}

// The subtree, because archiving cascades to it and stops each descendant's provider session.
function subtreeHasRunningTurn(readModel: OrchestrationReadModel, rootThreadId: ThreadId): boolean {
  return collectActiveThreadSubtree(readModel, rootThreadId).some(hasRunningTurn);
}

function activeReviewRoots(readModel: OrchestrationReadModel): OrchestrationThread[] {
  return readModel.threads.filter(
    (thread) => isArchiveCandidate(thread) && isReviewWorkflowThread(thread),
  );
}

// One entry per pull request; the caller decides which need a provider read.
export function liveReviewThreadPullRequests(
  readModel: OrchestrationReadModel,
): ReadonlyArray<ReviewThreadPullRequest> {
  const byRef = new Map<string, ReviewThreadPullRequest>();
  for (const thread of activeReviewRoots(readModel)) {
    for (const pullRequest of reviewThreadPullRequests(thread)) {
      const identity = threadPullRequestIdentity(pullRequest);
      if (identity.host === "unknown" || identity.repository.length === 0) continue;
      const ref: PullRequestRef = {
        projectId: thread.projectId,
        repository: identity.repository,
        number: identity.number,
      };
      const refKey = `${ref.projectId}/${ref.repository}#${ref.number}`;
      const pullRequestKey = threadPullRequestKey(pullRequest);
      const existing = byRef.get(refKey);
      byRef.set(refKey, {
        ref,
        pullRequestKeys:
          existing === undefined || existing.pullRequestKeys.includes(pullRequestKey)
            ? (existing?.pullRequestKeys ?? [pullRequestKey])
            : [...existing.pullRequestKeys, pullRequestKey],
        // A merge is terminal, so one thread recording it settles it for all of them.
        recordedState:
          existing?.recordedState === "merged" || pullRequest.state === "merged"
            ? "merged"
            : "unmerged",
      });
    }
  }
  return [...byRef.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, live]) => live);
}

// `thread.archive` already cascades to a thread's children, so nested review threads are skipped.
export function planReviewThreadAutoArchive(
  readModel: OrchestrationReadModel,
  mergedPullRequestKeys: ReadonlySet<string>,
): ReadonlyArray<ReviewThreadMergeArchiveCandidate> {
  if (mergedPullRequestKeys.size === 0) return [];
  const merged = activeReviewRoots(readModel).flatMap((thread) => {
    const pullRequestKey = reviewThreadPullRequests(thread)
      .map(threadPullRequestKey)
      .find((key) => mergedPullRequestKeys.has(key));
    if (pullRequestKey === undefined) return [];
    if (subtreeHasRunningTurn(readModel, thread.id)) return [];
    return [{ threadId: thread.id, pullRequestKey }];
  });

  // Decided over the whole set rather than against accepted threads, since the read model does not
  // order a parent before its children.
  const parentByThreadId = new Map(
    readModel.threads.flatMap((thread) =>
      thread.parentThreadId === undefined || thread.parentThreadId === null
        ? []
        : ([[thread.id, thread.parentThreadId]] as const),
    ),
  );
  const candidateIds = new Set(merged.map((candidate) => candidate.threadId));
  const hasCandidateAncestor = (threadId: ThreadId) => {
    const visited = new Set<ThreadId>();
    let parentId = parentByThreadId.get(threadId) ?? null;
    while (parentId !== null && !visited.has(parentId)) {
      if (candidateIds.has(parentId)) return true;
      visited.add(parentId);
      parentId = parentByThreadId.get(parentId) ?? null;
    }
    return false;
  };

  return merged.filter((candidate) => !hasCandidateAncestor(candidate.threadId));
}

// Derived from the outcome so a repeated sweep deduplicates through command receipts.
export function reviewThreadMergeArchiveCommandId(candidate: ReviewThreadMergeArchiveCandidate) {
  return `${candidate.threadId}:auto-archive-merge:${candidate.pullRequestKey}` as CommandId;
}

// Eager trigger so a merge observed on the event stream archives without
// waiting for the next periodic sweep. Only merged pull request writes qualify;
// everything else stays on the timer to avoid a sweep per chat event.
export function shouldTriggerMergeArchiveSweep(event: {
  readonly type: string;
  readonly payload?: unknown;
}): boolean {
  const payload = event.payload as
    | {
        readonly link?: { readonly pullRequest?: { readonly state?: unknown } } | undefined;
        readonly pullRequest?: { readonly state?: unknown } | null | undefined;
      }
    | undefined;
  switch (event.type) {
    case "thread.pull-request-linked":
    case "thread.pull-request-rekeyed":
      return payload?.link?.pullRequest?.state === "merged";
    case "thread.meta-updated":
    case "thread.created":
      return payload?.pullRequest?.state === "merged";
    default:
      return false;
  }
}

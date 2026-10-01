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

import { collectActiveThreadSubtree } from "../orchestration/threadHierarchy.ts";
import { isReviewWorkflowThread } from "./reviewWorkflowThread.ts";

export type ReviewThreadMergeArchiveCandidate = {
  readonly threadId: ThreadId;
  readonly pullRequestKey: string;
};

/**
 * A pull request a live review thread is watching, named both ways: the reference the provider
 * is asked about, and the thread-level keys that identify the same pull request in the read model.
 *
 * `recordedState` is what a review thread already knows. A merge recorded there needs no provider
 * read, and dropping it would leave that review thread unarchived for as long as it stays linked.
 */
export type ReviewThreadPullRequest = {
  readonly ref: PullRequestRef;
  readonly pullRequestKeys: ReadonlyArray<string>;
  readonly recordedState: "merged" | "unmerged";
};

export function reviewThreadPullRequests(
  thread: Pick<OrchestrationThread, "pullRequests" | "pullRequest">,
): ReadonlyArray<GitPullRequestAssociation> {
  const linked = (thread.pullRequests ?? []).map((link) => link.pullRequest);
  const legacy = thread.pullRequest;
  if (legacy === null || legacy === undefined) return linked;
  return [...linked, legacy];
}

/**
 * Whether this thread may be auto-archived right now, as admission re-checks it. The sweep's own
 * plan and this guard share one predicate so the two cannot drift apart: a thread that qualifies
 * for planning qualifies for admission.
 */
export function canAutoArchiveThreadNow(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): boolean {
  const thread = readModel.threads.find((entry) => entry.id === threadId);
  if (thread === undefined || !isArchiveCandidate(thread)) return false;
  if (!isReviewWorkflowThread(thread)) return false;
  // The planned pull request must still be the one this thread is watching; a link swapped while
  // the sweep was reading would otherwise archive on the old pull request's merge.
  if (reviewThreadPullRequests(thread).length === 0) return false;
  return !subtreeHasRunningTurn(readModel, threadId);
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

/**
 * `thread.archive` archives a thread's whole active subtree and stops each one's provider
 * session, so the guard has to cover delegated work too — a review root that has finished while
 * a child it delegated to is still running would otherwise take that child down with it.
 */
function subtreeHasRunningTurn(readModel: OrchestrationReadModel, rootThreadId: ThreadId): boolean {
  return collectActiveThreadSubtree(readModel, rootThreadId).some(hasRunningTurn);
}

function activeReviewRoots(readModel: OrchestrationReadModel): OrchestrationThread[] {
  return readModel.threads.filter(
    (thread) => isArchiveCandidate(thread) && isReviewWorkflowThread(thread),
  );
}

/**
 * Every pull request a live review thread is watching, whether or not the merge is already
 * recorded. One entry per pull request: the caller decides which entries need a provider read.
 */
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
        // A merge is terminal, so one thread recording it settles the pull request for all of them.
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

/**
 * The review threads to archive, one candidate per thread. `thread.archive` already archives a
 * thread's delegated children, so a nested review thread is left out rather than dispatched
 * separately against a parent the same sweep archives.
 */
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

  // Ancestor membership is decided over the whole candidate set rather than against the threads
  // already accepted, because the read model does not order a parent before its children and a
  // child accepted first would otherwise be archived separately from the parent that covers it.
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

/**
 * Derived from the outcome rather than generated, so a repeated sweep of the same merged pull
 * request deduplicates through the engine's command receipts instead of failing.
 */
export function reviewThreadMergeArchiveCommandId(candidate: ReviewThreadMergeArchiveCandidate) {
  return `${candidate.threadId}:auto-archive-merge:${candidate.pullRequestKey}` as CommandId;
}

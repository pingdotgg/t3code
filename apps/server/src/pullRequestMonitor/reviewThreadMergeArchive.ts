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

function isArchiveCandidate(thread: OrchestrationThread): boolean {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
  // Settling is a deliberate signal from the user; archiving would overwrite it.
  if (thread.settledOverride === "settled") return false;
  // Archiving stops the provider session, so a review that is still mid-turn would lose its
  // in-flight findings. A merged pull request stays merged, so the next sweep takes it instead.
  return thread.latestTurn?.state !== "running";
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
    return pullRequestKey === undefined ? [] : [{ threadId: thread.id, pullRequestKey }];
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

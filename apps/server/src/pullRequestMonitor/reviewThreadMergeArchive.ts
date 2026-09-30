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
 */
export type PendingReviewThreadPullRequest = {
  readonly ref: PullRequestRef;
  readonly pullRequestKeys: ReadonlyArray<string>;
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
  return thread.settledOverride !== "settled";
}

function activeReviewRoots(readModel: OrchestrationReadModel): OrchestrationThread[] {
  return readModel.threads.filter(
    (thread) => isArchiveCandidate(thread) && isReviewWorkflowThread(thread),
  );
}

/**
 * Pull requests whose merge state only the provider knows. A merge the thread already records is
 * excluded so a sweep never re-reads what it already knows.
 */
export function pendingReviewThreadPullRequests(
  readModel: OrchestrationReadModel,
): ReadonlyArray<PendingReviewThreadPullRequest> {
  const byRef = new Map<string, PendingReviewThreadPullRequest>();
  for (const thread of activeReviewRoots(readModel)) {
    for (const pullRequest of reviewThreadPullRequests(thread)) {
      if (pullRequest.state === "merged") continue;
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
      });
    }
  }
  return [...byRef.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, pending]) => pending);
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
  const candidates: ReviewThreadMergeArchiveCandidate[] = [];
  for (const thread of activeReviewRoots(readModel)) {
    const pullRequestKey = reviewThreadPullRequests(thread)
      .map(threadPullRequestKey)
      .find((key) => mergedPullRequestKeys.has(key));
    if (pullRequestKey === undefined) continue;
    const archivedByAncestor = candidates.some((candidate) =>
      collectActiveThreadSubtree(readModel, candidate.threadId).some(
        (descendant) => descendant.id === thread.id,
      ),
    );
    if (archivedByAncestor) continue;
    candidates.push({ threadId: thread.id, pullRequestKey });
  }
  return candidates;
}

/**
 * Derived from the outcome rather than generated, so a repeated sweep of the same merged pull
 * request deduplicates through the engine's command receipts instead of failing.
 */
export function reviewThreadMergeArchiveCommandId(candidate: ReviewThreadMergeArchiveCandidate) {
  return `${candidate.threadId}:auto-archive-merge:${candidate.pullRequestKey}` as CommandId;
}

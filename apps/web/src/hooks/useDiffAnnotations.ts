/**
 * Aggregates all annotation sources for a thread's diff views.
 *
 * Currently sources review comments; designed to be extended with additional
 * annotation providers (lint warnings, AI suggestions, etc.) by adding
 * more queries here and merging the results.
 *
 * DiffPanel and any other diff consumer should use this hook to get
 * annotations — they should never directly import review-comment-specific
 * query options or conversion helpers.
 */

import type { ReviewComment, ThreadId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { type DiffAnnotation, reviewCommentsToAnnotations } from "../lib/diffAnnotations";
import {
  invalidateReviewCommentQueries,
  reviewCommentListQueryOptions,
  REVIEW_COMMENT_POLL_INTERVAL_ACTIVE,
} from "../lib/reviewCommentReactQuery";
import { ensureNativeApi } from "../nativeApi";

/**
 * Returns a flat list of all annotations for the given thread.
 *
 * Polls for new review comments while the agent is actively running;
 * stops when idle. Future annotation sources (lint, AI suggestions, …)
 * will be merged here so consumers get a single, source-agnostic list.
 *
 * When `publishContext` is provided, each review comment annotation
 * gets an `onPublish` callback that publishes it to GitHub.
 */
export function useDiffAnnotations(
  threadId: ThreadId | null,
  isAgentActive: boolean,
  publishContext?: { cwd: string; prUrl: string } | undefined,
): DiffAnnotation[] {
  const reviewCommentsQuery = useQuery(
    reviewCommentListQueryOptions(
      threadId,
      isAgentActive ? REVIEW_COMMENT_POLL_INTERVAL_ACTIVE : false,
    ),
  );

  const queryClient = useQueryClient();
  const onPublish = useCallback(
    async (comment: ReviewComment) => {
      if (!threadId || !publishContext) return;
      const api = ensureNativeApi();
      const result = await api.reviewComment.publish({
        threadId,
        cwd: publishContext.cwd,
        prUrl: publishContext.prUrl,
        commentId: comment.id,
      });
      if (!result.published || result.published === 0) {
        throw new Error(result.error ?? "GitHub rejected the comment — check your permissions and PR access.");
      }
      await invalidateReviewCommentQueries(queryClient, threadId);
    },
    [threadId, publishContext, queryClient],
  );

  return useMemo(() => {
    const comments = reviewCommentsQuery.data?.comments;
    if (!comments || comments.length === 0) return [];
    return reviewCommentsToAnnotations(comments, publishContext ? onPublish : undefined);
    // Future: concat with lint annotations, AI suggestion annotations, etc.
  }, [reviewCommentsQuery.data?.comments, publishContext, onPublish]);
}

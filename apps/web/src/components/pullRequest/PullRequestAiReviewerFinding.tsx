import {
  parseAiReviewerFeedback,
  type AiReviewerFeedback,
} from "@t3tools/client-runtime/ai-reviewer-feedback";
import type { PullRequestComment } from "@t3tools/contracts";

export function pullRequestAiReviewerFeedback(
  comment: Pick<PullRequestComment, "body">,
): AiReviewerFeedback | null {
  return parseAiReviewerFeedback(comment.body);
}

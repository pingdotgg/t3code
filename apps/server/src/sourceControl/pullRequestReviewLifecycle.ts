/**
 * Pure model of where a pull request sits in its review lifecycle.
 *
 * Review bots (CodeRabbit and friends) work in phases that a bare unresolved
 * thread count cannot express: they announce that a review is running, then
 * post a review with actionable comments, then re-review after the fixes land.
 * A count of zero therefore means "nothing to fix right now" *or* "the bot has
 * not finished looking yet", and clients that only see the count offer to fix
 * comments that do not exist yet.
 *
 * The lifecycle is derived from what the bot leaves on the pull request:
 * - `review-in-progress` — a bot comment currently says it is reviewing. The
 *   bot edits this comment in place, so its present body is the live signal.
 * - `actionable-comments` — unresolved review threads remain.
 * - `review-complete` — a review was submitted and nothing is unresolved.
 *
 * `null` means unknown (no review activity yet, an unreadable payload, or a
 * provider that does not report threads). Callers must treat unknown as "no
 * lifecycle information", never as complete.
 */

export type PullRequestReviewLifecycle =
  | "review-in-progress"
  | "actionable-comments"
  | "review-complete";

export interface PullRequestReviewStatusSnapshot {
  readonly unresolvedReviewThreadCount: number | null;
  readonly actionableReviewItemCount: number | null;
  readonly reviewLifecycle: PullRequestReviewLifecycle | null;
}

interface ReviewBotComment {
  readonly login: string;
  readonly body: string;
}

/** Bots that post their review progress as PR comments. */
const REVIEW_BOT_LOGINS = new Set(["coderabbitai"]);

/**
 * Phrases a review bot leaves while a review is running. CodeRabbit edits its
 * summary comment to carry the first one; the others cover its older wording
 * and comparable bots.
 */
const IN_PROGRESS_MARKERS = [
  /currently processing new changes/i,
  /currently reviewing/i,
  /review in progress/i,
];

function normalizeLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

function isReviewBot(login: string): boolean {
  const normalized = normalizeLogin(login);
  return REVIEW_BOT_LOGINS.has(normalized);
}

function hasInProgressMarker(comments: ReadonlyArray<ReviewBotComment>): boolean {
  return comments.some(
    (comment) =>
      isReviewBot(comment.login) && IN_PROGRESS_MARKERS.some((marker) => marker.test(comment.body)),
  );
}

/**
 * `unresolvedReviewThreadCount` is null when the count is unknown (unreadable
 * payload or more threads than the single page fetched), which keeps callers
 * from treating a partial page as "all resolved".
 */
export function deriveReviewLifecycle(input: {
  readonly unresolvedReviewThreadCount: number | null;
  readonly hasSubmittedReview: boolean;
  readonly comments: ReadonlyArray<ReviewBotComment>;
}): PullRequestReviewLifecycle | null {
  if (hasInProgressMarker(input.comments)) {
    return "review-in-progress";
  }

  const unresolved = input.unresolvedReviewThreadCount;
  if (unresolved !== null && unresolved > 0) {
    return "actionable-comments";
  }
  if (!input.hasSubmittedReview) {
    return null;
  }
  return unresolved === 0 ? "review-complete" : null;
}

interface RawThreadConnection {
  nodes?: ReadonlyArray<{
    isResolved?: boolean;
    isOutdated?: boolean;
    comments?: { nodes?: ReadonlyArray<{ body?: string | null } | null> | null } | null;
  } | null> | null;
  pageInfo?: { hasNextPage?: boolean } | null;
}

interface RawCommentConnection {
  nodes?: ReadonlyArray<{
    author?: { login?: string | null } | null;
    body?: string | null;
  } | null> | null;
}

interface RawReviewStatusPayload {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: RawThreadConnection | null;
        reviews?: { nodes?: ReadonlyArray<{ state?: string | null } | null> | null } | null;
        firstComments?: RawCommentConnection | null;
        latestComments?: RawCommentConnection | null;
      } | null;
    } | null;
  } | null;
}

function analyzeReviewThreads(
  reviewThreads: RawThreadConnection | null | undefined,
): { unresolvedReviewThreadCount: number; actionableReviewItemCount: number } | null {
  const nodes = reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return null;
  if (reviewThreads?.pageInfo?.hasNextPage === true) return null;
  const unresolved = nodes.filter(
    (thread) => thread?.isResolved !== true && thread?.isOutdated !== true,
  );
  return {
    unresolvedReviewThreadCount: unresolved.length,
    actionableReviewItemCount: unresolved.filter((thread) =>
      thread?.comments?.nodes?.some(
        (comment: { readonly body?: string | null } | null) =>
          (comment?.body?.trim().length ?? 0) > 0,
      ),
    ).length,
  };
}

function collectComments(
  ...connections: ReadonlyArray<RawCommentConnection | null | undefined>
): ReadonlyArray<ReviewBotComment> {
  const comments: ReviewBotComment[] = [];
  for (const connection of connections) {
    const nodes = connection?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const login = node?.author?.login?.trim();
      if (!login) continue;
      comments.push({ login, body: node?.body ?? "" });
    }
  }
  return comments;
}

/**
 * Decodes the review-status GraphQL payload. A malformed payload degrades to
 * unknown on every field instead of failing: review status is best-effort and
 * must never break VCS status.
 */
export function parsePullRequestReviewStatus(raw: string): PullRequestReviewStatusSnapshot {
  let parsed: RawReviewStatusPayload;
  try {
    parsed = JSON.parse(raw) as RawReviewStatusPayload;
  } catch {
    return {
      unresolvedReviewThreadCount: null,
      actionableReviewItemCount: null,
      reviewLifecycle: null,
    };
  }

  const pullRequest = parsed.data?.repository?.pullRequest;
  const threadAnalysis = analyzeReviewThreads(pullRequest?.reviewThreads);
  const unresolvedReviewThreadCount = threadAnalysis?.unresolvedReviewThreadCount ?? null;
  const reviewNodes = pullRequest?.reviews?.nodes;
  const hasSubmittedReview =
    Array.isArray(reviewNodes) &&
    reviewNodes.some((review) => (review?.state?.trim().length ?? 0) > 0);

  return {
    unresolvedReviewThreadCount,
    actionableReviewItemCount: threadAnalysis?.actionableReviewItemCount ?? null,
    reviewLifecycle: deriveReviewLifecycle({
      unresolvedReviewThreadCount,
      hasSubmittedReview,
      comments: collectComments(pullRequest?.firstComments, pullRequest?.latestComments),
    }),
  };
}

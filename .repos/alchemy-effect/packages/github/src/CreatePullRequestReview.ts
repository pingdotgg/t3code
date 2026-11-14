import type * as Pulls from "@distilled.cloud/github/pulls";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface CreatePullRequestReviewRequest extends Omit<
  Pulls.CreateReviewRequest,
  "owner" | "repo"
> {}

export type CreatePullRequestReviewResponse = Pulls.PullRequestReview;

/**
 * Submit a pull request review (`pulls.createReview`): a `body`, an `event`
 * verdict (`APPROVE`, `REQUEST_CHANGES` or `COMMENT`) and inline `comments` on
 * diff lines, in one submission.
 *
 * Provide `GitHub.CreatePullRequestReviewHttp` on a Worker or Function, or
 * `GitHub.CreatePullRequestReviewLocal` on an Action.
 *
 * ### Reviewing Pull Requests at Runtime
 * **Example:** Request changes with an inline comment
 * ```typescript
 * const createReview = yield* GitHub.CreatePullRequestReview(yield* Repo);
 * yield* createReview({
 *   pull_number: 9,
 *   event: "REQUEST_CHANGES",
 *   body: "One problem, inline.",
 *   comments: [{ path: "src/index.ts", line: 42, body: "Off by one." }],
 * });
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface CreatePullRequestReview extends Binding.Service<
  CreatePullRequestReview,
  "GitHub.CreatePullRequestReview",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: CreatePullRequestReviewRequest,
    ) => Effect.Effect<CreatePullRequestReviewResponse, Pulls.CreateReviewError, RuntimeContext>
  >
> {}

export const CreatePullRequestReview = Binding.Service<CreatePullRequestReview>(
  "GitHub.CreatePullRequestReview",
);

import type * as Pulls from "@distilled.cloud/github/pulls";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface ListPullRequestReviewsRequest extends Omit<
  Pulls.ListReviewsRequest,
  "owner" | "repo"
> {}

export type ListPullRequestReviewsResponse = Pulls.ListReviewsResponse;

/**
 * List one page of a pull request's reviews (`pulls.listReviews`).
 *
 * Provide `GitHub.ListPullRequestReviewsHttp` on a Worker or Function, or
 * `GitHub.ListPullRequestReviewsLocal` on an Action.
 *
 * ### Listing Reviews at Runtime
 * **Example:** Check for an approval
 * ```typescript
 * const listReviews = yield* GitHub.ListPullRequestReviews(yield* Repo);
 * const reviews = yield* listReviews({ pull_number: 9 });
 * const approved = reviews.some((review) => review.state === "APPROVED");
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface ListPullRequestReviews extends Binding.Service<
  ListPullRequestReviews,
  "GitHub.ListPullRequestReviews",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: ListPullRequestReviewsRequest,
    ) => Effect.Effect<ListPullRequestReviewsResponse, Pulls.ListReviewsError, RuntimeContext>
  >
> {}

export const ListPullRequestReviews = Binding.Service<ListPullRequestReviews>(
  "GitHub.ListPullRequestReviews",
);

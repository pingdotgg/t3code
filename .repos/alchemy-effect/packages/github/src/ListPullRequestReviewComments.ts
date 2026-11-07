import type * as Pulls from "@distilled.cloud/github/pulls";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface ListPullRequestReviewCommentsRequest extends Omit<
  Pulls.ListReviewCommentsRequest,
  "owner" | "repo"
> {}

export type ListPullRequestReviewCommentsResponse = Pulls.ListReviewCommentsResponse;

/**
 * List one page of a pull request's inline review comments
 * (`pulls.listReviewComments`), each anchored to a `path` and `line` of the
 * diff.
 *
 * Provide `GitHub.ListPullRequestReviewCommentsHttp` on a Worker or Function, or
 * `GitHub.ListPullRequestReviewCommentsLocal` on an Action.
 *
 * ### Listing Review Comments at Runtime
 * **Example:** Read the inline comments
 * ```typescript
 * const listReviewComments = yield* GitHub.ListPullRequestReviewComments(yield* Repo);
 * const comments = yield* listReviewComments({ pull_number: 9, per_page: 100 });
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface ListPullRequestReviewComments extends Binding.Service<
  ListPullRequestReviewComments,
  "GitHub.ListPullRequestReviewComments",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: ListPullRequestReviewCommentsRequest,
    ) => Effect.Effect<
      ListPullRequestReviewCommentsResponse,
      Pulls.ListReviewCommentsError,
      RuntimeContext
    >
  >
> {}

export const ListPullRequestReviewComments = Binding.Service<ListPullRequestReviewComments>(
  "GitHub.ListPullRequestReviewComments",
);

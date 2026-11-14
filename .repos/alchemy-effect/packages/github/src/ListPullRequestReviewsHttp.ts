import * as Pulls from "@distilled.cloud/github/pulls";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  ListPullRequestReviews,
  type ListPullRequestReviewsRequest,
} from "./ListPullRequestReviews.ts";

export const listPullRequestReviewsOperation = BindingHttp.operation(
  "pulls.listReviews",
  (repo) => (request: ListPullRequestReviewsRequest) =>
    Pulls.listReviews({ owner: repo.owner, repo: repo.repository, ...request }),
);

/**
 * Token-backed implementation of {@link ListPullRequestReviews}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.ListPullRequestReviews
 */
export const ListPullRequestReviewsHttp = Layer.effect(
  ListPullRequestReviews,
  BindingHttp.make(listPullRequestReviewsOperation),
);

import * as Pulls from "@distilled.cloud/github/pulls";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  CreatePullRequestReview,
  type CreatePullRequestReviewRequest,
} from "./CreatePullRequestReview.ts";

export const createPullRequestReviewOperation = BindingHttp.operation(
  "pulls.createReview",
  (repo) => (request: CreatePullRequestReviewRequest) =>
    Pulls.createReview({ owner: repo.owner, repo: repo.repository, ...request }),
);

/**
 * Token-backed implementation of {@link CreatePullRequestReview}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.CreatePullRequestReview
 */
export const CreatePullRequestReviewHttp = Layer.effect(
  CreatePullRequestReview,
  BindingHttp.make(createPullRequestReviewOperation),
);

import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListPullRequestReviews } from "./ListPullRequestReviews.ts";
import { listPullRequestReviewsOperation } from "./ListPullRequestReviewsHttp.ts";

/**
 * Implementation of {@link ListPullRequestReviews} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.ListPullRequestReviews
 */
export const ListPullRequestReviewsLocal = Layer.effect(
  ListPullRequestReviews,
  BindingLocal.make(listPullRequestReviewsOperation),
);

import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListPullRequestReviewComments } from "./ListPullRequestReviewComments.ts";
import { listPullRequestReviewCommentsOperation } from "./ListPullRequestReviewCommentsHttp.ts";

/**
 * Implementation of {@link ListPullRequestReviewComments} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.ListPullRequestReviewComments
 */
export const ListPullRequestReviewCommentsLocal = Layer.effect(
  ListPullRequestReviewComments,
  BindingLocal.make(listPullRequestReviewCommentsOperation),
);

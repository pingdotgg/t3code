import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { CreatePullRequestReview } from "./CreatePullRequestReview.ts";
import { createPullRequestReviewOperation } from "./CreatePullRequestReviewHttp.ts";

/**
 * Implementation of {@link CreatePullRequestReview} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.CreatePullRequestReview
 */
export const CreatePullRequestReviewLocal = Layer.effect(
  CreatePullRequestReview,
  BindingLocal.make(createPullRequestReviewOperation),
);

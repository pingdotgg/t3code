import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { CreatePullRequest } from "./CreatePullRequest.ts";
import { createPullRequestOperation } from "./CreatePullRequestHttp.ts";

/**
 * Implementation of {@link CreatePullRequest} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.CreatePullRequest
 */
export const CreatePullRequestLocal = Layer.effect(
  CreatePullRequest,
  BindingLocal.make(createPullRequestOperation),
);

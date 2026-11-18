import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { MergePullRequest } from "./MergePullRequest.ts";
import { mergePullRequestOperation } from "./MergePullRequestHttp.ts";

/**
 * Implementation of {@link MergePullRequest} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.MergePullRequest
 */
export const MergePullRequestLocal = Layer.effect(
  MergePullRequest,
  BindingLocal.make(mergePullRequestOperation),
);

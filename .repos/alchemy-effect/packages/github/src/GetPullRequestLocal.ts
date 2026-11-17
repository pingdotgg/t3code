import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import type { Credentials } from "./Credentials.ts";
import { GetPullRequest } from "./GetPullRequest.ts";
import { getPullRequestOperation } from "./GetPullRequestHttp.ts";

/**
 * Implementation of {@link GetPullRequest} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.GetPullRequest
 */
export const GetPullRequestLocal: Layer.Layer<GetPullRequest, never, Credentials> = Layer.effect(
  GetPullRequest,
  BindingLocal.make(getPullRequestOperation) as never,
);

import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListPullRequests } from "./ListPullRequests.ts";
import { listPullRequestsOperation } from "./ListPullRequestsHttp.ts";

/**
 * Implementation of {@link ListPullRequests} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.ListPullRequests
 */
export const ListPullRequestsLocal = Layer.effect(
  ListPullRequests,
  BindingLocal.make(listPullRequestsOperation),
);

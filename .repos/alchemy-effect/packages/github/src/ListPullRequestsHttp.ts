import * as Pulls from "@distilled.cloud/github/pulls";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { ListPullRequests, type ListPullRequestsRequest } from "./ListPullRequests.ts";

export const listPullRequestsOperation = BindingHttp.operation(
  "pulls.list",
  (repo) => (request?: ListPullRequestsRequest) =>
    Pulls.list({ owner: repo.owner, repo: repo.repository, ...request }),
);

/**
 * Token-backed implementation of {@link ListPullRequests}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.ListPullRequests
 */
export const ListPullRequestsHttp = Layer.effect(
  ListPullRequests,
  BindingHttp.make(listPullRequestsOperation),
);

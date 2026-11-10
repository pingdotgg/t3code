import type { GithubOpContext } from "@distilled.cloud/github";
import * as Pulls from "@distilled.cloud/github/pulls";
import type { Self } from "alchemy/Self";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { GetPullRequest, type GetPullRequestRequest } from "./GetPullRequest.ts";

export const getPullRequestOperation = BindingHttp.operation(
  "pulls.get",
  (repo) =>
    ({
      accept,
      ...request
    }: GetPullRequestRequest): Effect.Effect<
      Pulls.PullRequest | string,
      Pulls.GetError,
      GithubOpContext
    > => {
      // One branch per overload: the JSON object, or the text media type's text.
      const scope = { owner: repo.owner, repo: repo.repository, ...request };
      return accept === undefined || accept === "application/vnd.github+json"
        ? Pulls.get({ ...scope, accept })
        : Pulls.get({ ...scope, accept });
    },
);

/**
 * Token-backed implementation of {@link GetPullRequest}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.GetPullRequest
 */
export const GetPullRequestHttp: Layer.Layer<GetPullRequest, never, Self> = Layer.effect(
  GetPullRequest,
  BindingHttp.make(getPullRequestOperation) as never,
);

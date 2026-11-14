import type * as Pulls from "@distilled.cloud/github/pulls";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

/** The `accept` media types GitHub answers with text instead of JSON. */
export type PullRequestTextMediaType = Exclude<
  Pulls.GetRequestAccept,
  "application/vnd.github+json"
>;

export interface GetPullRequestRequest extends Omit<Pulls.GetRequest, "owner" | "repo" | "accept"> {
  /** `application/vnd.github.diff` or `.patch` returns the text instead of the JSON object. */
  readonly accept?: Pulls.GetRequestAccept;
}

export type GetPullRequestResponse = Pulls.PullRequest;

/**
 * Get a pull request by number (`pulls.get`). Like the API, `accept` selects
 * the media type: `application/vnd.github.diff` or
 * `application/vnd.github.patch` return the diff or patch text instead of the
 * JSON object.
 *
 * Provide `GitHub.GetPullRequestHttp` on a Worker or Function, or
 * `GitHub.GetPullRequestLocal` on an Action.
 *
 * ### Reading Pull Requests at Runtime
 * **Example:** Get a pull request and its diff
 * ```typescript
 * const getPullRequest = yield* GitHub.GetPullRequest(yield* Repo);
 * const pull = yield* getPullRequest({ pull_number: 9 });
 * const diff = yield* getPullRequest({
 *   pull_number: 9,
 *   accept: "application/vnd.github.diff",
 * });
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface GetPullRequest extends Binding.Service<
  GetPullRequest,
  "GitHub.GetPullRequest",
  (
    repo: Repository,
  ) => Effect.Effect<
    <Accept extends GetPullRequestRequest["accept"] = undefined>(
      request: GetPullRequestRequest & { readonly accept?: Accept },
    ) => Effect.Effect<
      Accept extends PullRequestTextMediaType ? string : GetPullRequestResponse,
      Pulls.GetError,
      RuntimeContext
    >
  >
> {}

export const GetPullRequest = Binding.Service<GetPullRequest>("GitHub.GetPullRequest");

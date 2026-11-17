import type * as Pulls from "@distilled.cloud/github/pulls";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface CreatePullRequestRequest extends Omit<Pulls.CreateRequest, "owner" | "repo"> {}

export type CreatePullRequestResponse = Pulls.PullRequest;

/**
 * Open a pull request (`pulls.create`). The `head` branch must already exist;
 * pushing commits to it is up to the caller.
 *
 * Provide `GitHub.CreatePullRequestHttp` on a Worker or Function, or
 * `GitHub.CreatePullRequestLocal` on an Action.
 *
 * ### Opening Pull Requests at Runtime
 * **Example:** Open a pull request from a branch
 * ```typescript
 * const createPullRequest = yield* GitHub.CreatePullRequest(yield* Repo);
 * const pull = yield* createPullRequest({
 *   title: "fix: typo in README",
 *   head: "fix/readme-typo",
 *   base: "main",
 *   body: "Closes #7.",
 * });
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface CreatePullRequest extends Binding.Service<
  CreatePullRequest,
  "GitHub.CreatePullRequest",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: CreatePullRequestRequest,
    ) => Effect.Effect<CreatePullRequestResponse, Pulls.CreateError, RuntimeContext>
  >
> {}

export const CreatePullRequest = Binding.Service<CreatePullRequest>("GitHub.CreatePullRequest");

import type * as Issues from "@distilled.cloud/github/issues";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface CreateIssueRequest extends Omit<Issues.CreateRequest, "owner" | "repo"> {}

export type CreateIssueResponse = Issues.Issue;

/**
 * Open an issue in the bound repository (`issues.create`).
 *
 * Provide `GitHub.CreateIssueHttp` on a Worker or Function, or
 * `GitHub.CreateIssueLocal` on an Action.
 *
 * ### Opening Issues at Runtime
 * **Example:** Open an issue from a Worker
 * ```typescript
 * const createIssue = yield* GitHub.CreateIssue(yield* Repo);
 * const issue = yield* createIssue({
 *   title: "Deploy failed",
 *   body: "See the logs for details.",
 *   labels: ["incident"],
 * });
 * ```
 *
 * @binding
 * @product Issue
 */
export interface CreateIssue extends Binding.Service<
  CreateIssue,
  "GitHub.CreateIssue",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: CreateIssueRequest,
    ) => Effect.Effect<CreateIssueResponse, Issues.CreateError, RuntimeContext>
  >
> {}

export const CreateIssue = Binding.Service<CreateIssue>("GitHub.CreateIssue");

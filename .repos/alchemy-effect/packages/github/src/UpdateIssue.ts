import type { NotFound } from "@distilled.cloud/github/Errors";
import type * as Issues from "@distilled.cloud/github/issues";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IssueNotFound } from "./Errors.ts";
import type { Repository } from "./Repository.ts";

export interface UpdateIssueRequest extends Omit<Issues.UpdateRequest, "owner" | "repo"> {}

export type UpdateIssueResponse = Issues.UpdateResponse;

/**
 * Update one issue by number (`issues.update`): state, title, body, labels,
 * assignees. A missing issue fails with the typed {@link IssueNotFound}.
 *
 * Provide `GitHub.UpdateIssueHttp` on a Worker or Function, or
 * `GitHub.UpdateIssueLocal` on an Action.
 *
 * ### Updating Issues at Runtime
 * **Example:** Close an issue as completed
 * ```typescript
 * const updateIssue = yield* GitHub.UpdateIssue(yield* Repo);
 * yield* updateIssue({
 *   issue_number: 7,
 *   state: "closed",
 *   state_reason: "completed",
 * });
 * ```
 *
 * @binding
 * @product Issue
 */
export interface UpdateIssue extends Binding.Service<
  UpdateIssue,
  "GitHub.UpdateIssue",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: UpdateIssueRequest,
    ) => Effect.Effect<
      UpdateIssueResponse,
      Exclude<Issues.UpdateError, NotFound> | IssueNotFound,
      RuntimeContext
    >
  >
> {}

export const UpdateIssue = Binding.Service<UpdateIssue>("GitHub.UpdateIssue");

import type { NotFound } from "@distilled.cloud/github/Errors";
import type * as Issues from "@distilled.cloud/github/issues";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IssueNotFound } from "./Errors.ts";
import type { Repository } from "./Repository.ts";

export interface GetIssueRequest extends Omit<Issues.GetRequest, "owner" | "repo"> {}

export type GetIssueResponse = Issues.Issue;

/**
 * Get one issue by number (`issues.get`). A missing issue fails with the typed
 * {@link IssueNotFound}.
 *
 * Provide `GitHub.GetIssueHttp` on a Worker or Function, or
 * `GitHub.GetIssueLocal` on an Action.
 *
 * ### Reading Issues at Runtime
 * **Example:** Get an issue, treating a missing one as absent
 * ```typescript
 * const getIssue = yield* GitHub.GetIssue(yield* Repo);
 * const issue = yield* getIssue({ issue_number: 7 }).pipe(
 *   Effect.catchTag("IssueNotFound", () => Effect.succeed(undefined)),
 * );
 * ```
 *
 * @binding
 * @product Issue
 */
export interface GetIssue extends Binding.Service<
  GetIssue,
  "GitHub.GetIssue",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: GetIssueRequest,
    ) => Effect.Effect<
      GetIssueResponse,
      Exclude<Issues.GetError, NotFound> | IssueNotFound,
      RuntimeContext
    >
  >
> {}

export const GetIssue = Binding.Service<GetIssue>("GitHub.GetIssue");

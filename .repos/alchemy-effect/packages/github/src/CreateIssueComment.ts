import type * as Issues from "@distilled.cloud/github/issues";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface CreateIssueCommentRequest extends Omit<
  Issues.CreateCommentRequest,
  "owner" | "repo"
> {}

export type CreateIssueCommentResponse = Issues.IssueComment;

/**
 * Comment on an issue or pull request (`issues.createComment`). Pass a pull
 * request's number as `issue_number`.
 *
 * Provide `GitHub.CreateIssueCommentHttp` on a Worker or Function, or
 * `GitHub.CreateIssueCommentLocal` on an Action.
 *
 * ### Commenting at Runtime
 * **Example:** Reply on an issue
 * ```typescript
 * const createComment = yield* GitHub.CreateIssueComment(yield* Repo);
 * yield* createComment({ issue_number: 7, body: "On it." });
 * ```
 *
 * @binding
 * @product Issue
 */
export interface CreateIssueComment extends Binding.Service<
  CreateIssueComment,
  "GitHub.CreateIssueComment",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: CreateIssueCommentRequest,
    ) => Effect.Effect<CreateIssueCommentResponse, Issues.CreateCommentError, RuntimeContext>
  >
> {}

export const CreateIssueComment = Binding.Service<CreateIssueComment>("GitHub.CreateIssueComment");

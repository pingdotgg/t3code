import * as Issues from "@distilled.cloud/github/issues";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { CreateIssueComment, type CreateIssueCommentRequest } from "./CreateIssueComment.ts";

export const createIssueCommentOperation = BindingHttp.operation(
  "issues.createComment",
  (repo) => (request: CreateIssueCommentRequest) =>
    Issues.createComment({ owner: repo.owner, repo: repo.repository, ...request }),
);

/**
 * Token-backed implementation of {@link CreateIssueComment}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Issue
 * @provides GitHub.CreateIssueComment
 */
export const CreateIssueCommentHttp = Layer.effect(
  CreateIssueComment,
  BindingHttp.make(createIssueCommentOperation),
);

import * as Issues from "@distilled.cloud/github/issues";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { ListIssueComments, type ListIssueCommentsRequest } from "./ListIssueComments.ts";

export const listIssueCommentsOperation = BindingHttp.operation(
  "issues.listComments",
  (repo) => (request: ListIssueCommentsRequest) =>
    Issues.listComments({ owner: repo.owner, repo: repo.repository, ...request }),
);

/**
 * Token-backed implementation of {@link ListIssueComments}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Issue
 * @provides GitHub.ListIssueComments
 */
export const ListIssueCommentsHttp = Layer.effect(
  ListIssueComments,
  BindingHttp.make(listIssueCommentsOperation),
);

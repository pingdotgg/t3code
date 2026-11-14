import * as Issues from "@distilled.cloud/github/issues";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { CreateIssue, type CreateIssueRequest } from "./CreateIssue.ts";

export const createIssueOperation = BindingHttp.operation(
  "issues.create",
  (repo) => (request: CreateIssueRequest) =>
    Issues.create({ owner: repo.owner, repo: repo.repository, ...request }),
);

/**
 * Token-backed implementation of {@link CreateIssue}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Issue
 * @provides GitHub.CreateIssue
 */
export const CreateIssueHttp = Layer.effect(CreateIssue, BindingHttp.make(createIssueOperation));

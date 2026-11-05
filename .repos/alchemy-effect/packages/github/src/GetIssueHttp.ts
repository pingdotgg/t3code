import * as Issues from "@distilled.cloud/github/issues";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { IssueNotFound } from "./Errors.ts";
import { GetIssue, type GetIssueRequest } from "./GetIssue.ts";

export const getIssueOperation = BindingHttp.operation(
  "issues.get",
  (repo) => (request: GetIssueRequest) =>
    Issues.get({ owner: repo.owner, repo: repo.repository, ...request }).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.fail(
          new IssueNotFound({
            owner: repo.owner,
            repository: repo.repository,
            number: request.issue_number,
          }),
        ),
      ),
    ),
);

/**
 * Token-backed implementation of {@link GetIssue}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Issue
 * @provides GitHub.GetIssue
 */
export const GetIssueHttp = Layer.effect(GetIssue, BindingHttp.make(getIssueOperation));

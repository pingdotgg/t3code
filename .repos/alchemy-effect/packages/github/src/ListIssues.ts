import type * as Issues from "@distilled.cloud/github/issues";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface ListIssuesRequest extends Omit<Issues.ListForRepoRequest, "owner" | "repo"> {}

export type ListIssuesResponse = Issues.ListForRepoResponse;

/**
 * List one page of the repository's issues (`issues.listForRepo`). GitHub
 * includes pull requests in this list; they carry a `pull_request` key.
 *
 * Provide `GitHub.ListIssuesHttp` on a Worker or Function, or
 * `GitHub.ListIssuesLocal` on an Action.
 *
 * ### Listing Issues at Runtime
 * **Example:** List open issues
 * ```typescript
 * const listIssues = yield* GitHub.ListIssues(yield* Repo);
 * const open = yield* listIssues({ state: "open", per_page: 100 });
 * const issues = open.filter((issue) => issue.pull_request === undefined);
 * ```
 *
 * @binding
 * @product Issue
 */
export interface ListIssues extends Binding.Service<
  ListIssues,
  "GitHub.ListIssues",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request?: ListIssuesRequest,
    ) => Effect.Effect<ListIssuesResponse, Issues.ListForRepoError, RuntimeContext>
  >
> {}

export const ListIssues = Binding.Service<ListIssues>("GitHub.ListIssues");

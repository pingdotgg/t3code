import type * as Search from "@distilled.cloud/github/search";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

/**
 * GitHub search syntax without the repository qualifier; the binding adds
 * `repo:{owner}/{name}`.
 */
export interface SearchIssuesRequest extends Search.IssuesAndPullRequestsRequest {}

export type SearchIssuesResponse = Search.IssuesAndPullRequestsResponse;

/**
 * Search issues and pull requests in the bound repository
 * (`search.issuesAndPullRequests`). The binding prefixes `q` with
 * `repo:{owner}/{name}`. GitHub's search index lags writes by a few seconds.
 *
 * Provide `GitHub.SearchIssuesHttp` on a Worker or Function, or
 * `GitHub.SearchIssuesLocal` on an Action.
 *
 * ### Searching Issues at Runtime
 * **Example:** Find open bugs by title
 * ```typescript
 * const searchIssues = yield* GitHub.SearchIssues(yield* Repo);
 * const { items } = yield* searchIssues({ q: "is:open label:bug crash in:title" });
 * ```
 *
 * @binding
 * @product Issue
 */
export interface SearchIssues extends Binding.Service<
  SearchIssues,
  "GitHub.SearchIssues",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: SearchIssuesRequest,
    ) => Effect.Effect<SearchIssuesResponse, Search.IssuesAndPullRequestsError, RuntimeContext>
  >
> {}

export const SearchIssues = Binding.Service<SearchIssues>("GitHub.SearchIssues");

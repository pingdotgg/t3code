import type * as Pulls from "@distilled.cloud/github/pulls";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface ListPullRequestFilesRequest extends Omit<
  Pulls.ListFilesRequest,
  "owner" | "repo"
> {}

export type ListPullRequestFilesResponse = Pulls.ListFilesResponse;

/**
 * List one page of the files a pull request changes (`pulls.listFiles`), each
 * with its status, line counts and `patch`. Unlike `GetPullRequest` with
 * `format: "diff"`, it pages through changes of any size (up to 3000 files).
 *
 * Provide `GitHub.ListPullRequestFilesHttp` on a Worker or Function, or
 * `GitHub.ListPullRequestFilesLocal` on an Action.
 *
 * ### Listing Changed Files at Runtime
 * **Example:** List the changed paths
 * ```typescript
 * const listFiles = yield* GitHub.ListPullRequestFiles(yield* Repo);
 * const files = yield* listFiles({ pull_number: 9, per_page: 100 });
 * const paths = files.map((file) => file.filename);
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface ListPullRequestFiles extends Binding.Service<
  ListPullRequestFiles,
  "GitHub.ListPullRequestFiles",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: ListPullRequestFilesRequest,
    ) => Effect.Effect<ListPullRequestFilesResponse, Pulls.ListFilesError, RuntimeContext>
  >
> {}

export const ListPullRequestFiles = Binding.Service<ListPullRequestFiles>(
  "GitHub.ListPullRequestFiles",
);

import type * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Repository } from "./Repository.ts";

export interface FetchGitRefsRequest extends Omit<
  cloudbuild.FetchGitRefsProjectsLocationsConnectionsRepositoriesRequest,
  "repository"
> {}

/**
 * Runtime binding for Cloud Build v2 `repositories.fetchGitRefs`.
 *
 * Bind this operation to a {@link Repository} in a Function/Action init
 * phase. Provide {@link FetchGitRefsHttp}.
 *
 * ### Listing Branches
 * **Example:** Fetch branch names
 * ```typescript
 * const fetchGitRefs = yield* GCP.CloudBuild.FetchGitRefs(source);
 * const { refNames } = yield* fetchGitRefs({ refType: "BRANCH" });
 * ```
 *
 * **Example:** Fetch tags
 * ```typescript
 * const { refNames } = yield* fetchGitRefs({ refType: "TAG", pageSize: 50 });
 * ```
 *
 * @binding
 * @category CloudBuild
 */
export interface FetchGitRefs extends Binding.Service<
  FetchGitRefs,
  "GCP.CloudBuild.FetchGitRefs",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: FetchGitRefsRequest,
    ) => Effect.Effect<
      cloudbuild.FetchGitRefsResponse,
      cloudbuild.FetchGitRefsProjectsLocationsConnectionsRepositoriesError,
      RuntimeContext
    >
  >
> {}

export const FetchGitRefs = Binding.Service<FetchGitRefs>(
  "GCP.CloudBuild.FetchGitRefs",
);

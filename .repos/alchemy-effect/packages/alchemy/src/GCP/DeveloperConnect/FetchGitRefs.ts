import type * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ConnectionsGitRepositoryLink } from "./ConnectionsGitRepositoryLink.ts";

export interface FetchGitRefsRequest extends Omit<
  developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksRequest,
  "gitRepositoryLink"
> {}

/**
 * Runtime binding for Developer Connect `gitRepositoryLinks.fetchGitRefs`.
 *
 * Bind this operation to a {@link ConnectionsGitRepositoryLink} in a
 * Function/Action init phase. Provide {@link FetchGitRefsHttp}.
 *
 * ### Listing Branches
 * **Example:** Fetch branch names
 * ```typescript
 * const fetchGitRefs = yield* GCP.DeveloperConnect.FetchGitRefs(source);
 * const { refNames } = yield* fetchGitRefs({ refType: "BRANCH" });
 * ```
 *
 * **Example:** Fetch tags
 * ```typescript
 * const { refNames } = yield* fetchGitRefs({ refType: "TAG", pageSize: 50 });
 * ```
 *
 * @binding
 * @category DeveloperConnect
 */
export interface FetchGitRefs extends Binding.Service<
  FetchGitRefs,
  "GCP.DeveloperConnect.FetchGitRefs",
  (
    link: ConnectionsGitRepositoryLink,
  ) => Effect.Effect<
    (
      request?: FetchGitRefsRequest,
    ) => Effect.Effect<
      developerconnect.FetchGitRefsResponse,
      developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksError,
      RuntimeContext
    >
  >
> {}

export const FetchGitRefs = Binding.Service<FetchGitRefs>(
  "GCP.DeveloperConnect.FetchGitRefs",
);

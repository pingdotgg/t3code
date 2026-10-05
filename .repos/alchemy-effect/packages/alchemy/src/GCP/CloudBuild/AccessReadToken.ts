import type * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Repository } from "./Repository.ts";

export interface AccessReadTokenRequest extends Omit<
  cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesRequest,
  "repository"
> {}

/**
 * Runtime binding for Cloud Build v2 `repositories.accessReadToken`.
 *
 * Bind this operation to a {@link Repository} in a Function/Action init
 * phase. Provide {@link AccessReadTokenHttp}. Returns a short-lived token
 * that can clone the remote Git repository.
 *
 * ### Fetching a Read Token
 * **Example:** Clone with a read token
 * ```typescript
 * const accessReadToken = yield* GCP.CloudBuild.AccessReadToken(source);
 * const { token, expirationTime } = yield* accessReadToken();
 * ```
 *
 * @binding
 * @category CloudBuild
 */
export interface AccessReadToken extends Binding.Service<
  AccessReadToken,
  "GCP.CloudBuild.AccessReadToken",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: AccessReadTokenRequest,
    ) => Effect.Effect<
      cloudbuild.FetchReadTokenResponse,
      cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesError,
      RuntimeContext
    >
  >
> {}

export const AccessReadToken = Binding.Service<AccessReadToken>(
  "GCP.CloudBuild.AccessReadToken",
);

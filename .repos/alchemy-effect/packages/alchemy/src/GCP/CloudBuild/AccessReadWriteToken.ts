import type * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Repository } from "./Repository.ts";

export interface AccessReadWriteTokenRequest extends Omit<
  cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesRequest,
  "repository"
> {}

/**
 * Runtime binding for Cloud Build v2 `repositories.accessReadWriteToken`.
 *
 * Bind this operation to a {@link Repository} in a Function/Action init
 * phase. Provide {@link AccessReadWriteTokenHttp}. Returns a short-lived
 * token that can clone and push to the remote Git repository.
 *
 * ### Fetching a Read/Write Token
 * **Example:** Push with a read/write token
 * ```typescript
 * const accessReadWriteToken = yield* GCP.CloudBuild.AccessReadWriteToken(source);
 * const { token, expirationTime } = yield* accessReadWriteToken();
 * ```
 *
 * @binding
 * @category CloudBuild
 */
export interface AccessReadWriteToken extends Binding.Service<
  AccessReadWriteToken,
  "GCP.CloudBuild.AccessReadWriteToken",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: AccessReadWriteTokenRequest,
    ) => Effect.Effect<
      cloudbuild.FetchReadWriteTokenResponse,
      cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesError,
      RuntimeContext
    >
  >
> {}

export const AccessReadWriteToken = Binding.Service<AccessReadWriteToken>(
  "GCP.CloudBuild.AccessReadWriteToken",
);

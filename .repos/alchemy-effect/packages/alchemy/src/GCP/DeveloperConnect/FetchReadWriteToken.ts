import type * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ConnectionsGitRepositoryLink } from "./ConnectionsGitRepositoryLink.ts";

export interface FetchReadWriteTokenRequest extends Omit<
  developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
  "gitRepositoryLink"
> {}

/**
 * Runtime binding for Developer Connect
 * `gitRepositoryLinks.fetchReadWriteToken`.
 *
 * Bind this operation to a {@link ConnectionsGitRepositoryLink} in a
 * Function/Action init phase. Provide {@link FetchReadWriteTokenHttp}.
 * Returns a short-lived token that can clone and push to the remote
 * Git repository.
 *
 * ### Fetching a Read/Write Token
 * **Example:** Push with a read/write token
 * ```typescript
 * const fetchReadWriteToken = yield* GCP.DeveloperConnect.FetchReadWriteToken(
 *   source,
 * );
 * const { token, expirationTime } = yield* fetchReadWriteToken();
 * ```
 *
 * @binding
 * @category DeveloperConnect
 */
export interface FetchReadWriteToken extends Binding.Service<
  FetchReadWriteToken,
  "GCP.DeveloperConnect.FetchReadWriteToken",
  (
    link: ConnectionsGitRepositoryLink,
  ) => Effect.Effect<
    (
      request?: FetchReadWriteTokenRequest,
    ) => Effect.Effect<
      developerconnect.FetchReadWriteTokenResponse,
      developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksError,
      RuntimeContext
    >
  >
> {}

export const FetchReadWriteToken = Binding.Service<FetchReadWriteToken>(
  "GCP.DeveloperConnect.FetchReadWriteToken",
);

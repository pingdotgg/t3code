import type * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ConnectionsGitRepositoryLink } from "./ConnectionsGitRepositoryLink.ts";

export interface FetchReadTokenRequest extends Omit<
  developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
  "gitRepositoryLink"
> {}

/**
 * Runtime binding for Developer Connect `gitRepositoryLinks.fetchReadToken`.
 *
 * Bind this operation to a {@link ConnectionsGitRepositoryLink} in a
 * Function/Action init phase. Provide {@link FetchReadTokenHttp}.
 * Returns a short-lived token that can clone the remote Git repository.
 *
 * ### Fetching a Read Token
 * **Example:** Clone with a read token
 * ```typescript
 * const fetchReadToken = yield* GCP.DeveloperConnect.FetchReadToken(source);
 * const { token, expirationTime } = yield* fetchReadToken();
 * ```
 *
 * @binding
 * @category DeveloperConnect
 */
export interface FetchReadToken extends Binding.Service<
  FetchReadToken,
  "GCP.DeveloperConnect.FetchReadToken",
  (
    link: ConnectionsGitRepositoryLink,
  ) => Effect.Effect<
    (
      request?: FetchReadTokenRequest,
    ) => Effect.Effect<
      developerconnect.FetchReadTokenResponse,
      developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksError,
      RuntimeContext
    >
  >
> {}

export const FetchReadToken = Binding.Service<FetchReadToken>(
  "GCP.DeveloperConnect.FetchReadToken",
);

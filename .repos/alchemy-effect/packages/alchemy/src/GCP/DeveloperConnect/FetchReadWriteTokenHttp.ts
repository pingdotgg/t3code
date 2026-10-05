import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGitRepositoryLinkHttpBinding } from "./BindingHttp.ts";
import { FetchReadWriteToken } from "./FetchReadWriteToken.ts";

/**
 * HTTP implementation of {@link FetchReadWriteToken}.
 *
 * @layer
 * @provides GCP.DeveloperConnect.FetchReadWriteToken
 */
export const FetchReadWriteTokenHttp = Layer.effect(
  FetchReadWriteToken,
  makeGitRepositoryLinkHttpBinding<
    developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
    developerconnect.FetchReadWriteTokenResponse,
    developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksError
  >({
    tag: "GCP.DeveloperConnect.FetchReadWriteToken",
    iam: { role: "roles/developerconnect.tokenAccessor" },
    operation: Effect.gen(function* () {
      const call =
        yield* developerconnect.fetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinks;
      return (
        input: developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
      ) => call(input);
    }),
  }),
);

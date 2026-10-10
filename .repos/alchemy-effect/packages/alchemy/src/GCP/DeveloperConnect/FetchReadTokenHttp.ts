import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGitRepositoryLinkHttpBinding } from "./BindingHttp.ts";
import { FetchReadToken } from "./FetchReadToken.ts";

/**
 * HTTP implementation of {@link FetchReadToken}.
 *
 * @layer
 * @provides GCP.DeveloperConnect.FetchReadToken
 */
export const FetchReadTokenHttp = Layer.effect(
  FetchReadToken,
  makeGitRepositoryLinkHttpBinding<
    developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
    developerconnect.FetchReadTokenResponse,
    developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksError
  >({
    tag: "GCP.DeveloperConnect.FetchReadToken",
    iam: { role: "roles/developerconnect.readTokenAccessor" },
    operation: Effect.gen(function* () {
      const call =
        yield* developerconnect.fetchReadTokenProjectsLocationsConnectionsGitRepositoryLinks;
      return (
        input: developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
      ) => call(input);
    }),
  }),
);

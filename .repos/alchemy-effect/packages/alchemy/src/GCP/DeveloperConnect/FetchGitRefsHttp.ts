import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGitRepositoryLinkHttpBinding } from "./BindingHttp.ts";
import { FetchGitRefs } from "./FetchGitRefs.ts";

/**
 * HTTP implementation of {@link FetchGitRefs}.
 *
 * @layer
 * @provides GCP.DeveloperConnect.FetchGitRefs
 */
export const FetchGitRefsHttp = Layer.effect(
  FetchGitRefs,
  makeGitRepositoryLinkHttpBinding<
    developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksRequest,
    developerconnect.FetchGitRefsResponse,
    developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksError
  >({
    tag: "GCP.DeveloperConnect.FetchGitRefs",
    iam: { role: "roles/developerconnect.user" },
    operation: Effect.gen(function* () {
      const call =
        yield* developerconnect.fetchGitRefsProjectsLocationsConnectionsGitRepositoryLinks;
      return (
        input: developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksRequest,
      ) => call(input);
    }),
  }),
);

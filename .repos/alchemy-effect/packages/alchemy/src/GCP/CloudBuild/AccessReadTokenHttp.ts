import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AccessReadToken } from "./AccessReadToken.ts";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link AccessReadToken}.
 *
 * @layer
 * @provides GCP.CloudBuild.AccessReadToken
 */
export const AccessReadTokenHttp = Layer.effect(
  AccessReadToken,
  Effect.gen(function* () {
    const access =
      yield* cloudbuild.accessReadTokenProjectsLocationsConnectionsRepositories;
    return yield* makeRepositoryHttpBinding<
      cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesRequest,
      cloudbuild.FetchReadTokenResponse,
      cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesError
    >({
      tag: "GCP.CloudBuild.AccessReadToken",
      iam: { role: "roles/cloudbuild.readTokenAccessor" },
      operation: (input) =>
        access({
          ...input,
          body: input.body ?? {},
        }),
    });
  }),
);

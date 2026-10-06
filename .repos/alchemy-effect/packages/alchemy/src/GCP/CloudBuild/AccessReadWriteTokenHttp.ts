import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AccessReadWriteToken } from "./AccessReadWriteToken.ts";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link AccessReadWriteToken}.
 *
 * @layer
 * @provides GCP.CloudBuild.AccessReadWriteToken
 */
export const AccessReadWriteTokenHttp = Layer.effect(
  AccessReadWriteToken,
  Effect.gen(function* () {
    const access =
      yield* cloudbuild.accessReadWriteTokenProjectsLocationsConnectionsRepositories;
    return yield* makeRepositoryHttpBinding<
      cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesRequest,
      cloudbuild.FetchReadWriteTokenResponse,
      cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesError
    >({
      tag: "GCP.CloudBuild.AccessReadWriteToken",
      iam: { role: "roles/cloudbuild.tokenAccessor" },
      operation: (input) =>
        access({
          ...input,
          body: input.body ?? {},
        }),
    });
  }),
);

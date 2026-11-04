import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";
import { FetchGitRefs } from "./FetchGitRefs.ts";

/**
 * HTTP implementation of {@link FetchGitRefs}.
 *
 * @layer
 * @provides GCP.CloudBuild.FetchGitRefs
 */
export const FetchGitRefsHttp = Layer.effect(
  FetchGitRefs,
  makeRepositoryHttpBinding({
    tag: "GCP.CloudBuild.FetchGitRefs",
    iam: { role: "roles/cloudbuild.connectionViewer" },
    operation: cloudbuild.fetchGitRefsProjectsLocationsConnectionsRepositories,
  }),
);

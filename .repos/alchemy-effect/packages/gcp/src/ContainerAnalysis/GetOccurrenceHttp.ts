import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import * as Layer from "effect/Layer";
import { makeOccurrenceHttpBinding } from "./BindingHttp.ts";
import { GetOccurrence } from "./GetOccurrence.ts";

/**
 * HTTP implementation of {@link GetOccurrence}.
 *
 * @layer
 * @provides GCP.ContainerAnalysis.GetOccurrence
 */
export const GetOccurrenceHttp = Layer.effect(
  GetOccurrence,
  makeOccurrenceHttpBinding({
    tag: "GCP.ContainerAnalysis.GetOccurrence",
    // Occurrences have no IAM policy of their own.
    iam: { role: "roles/containeranalysis.occurrences.viewer" },
    operation: containeranalysis.getProjectsOccurrences,
  }),
);

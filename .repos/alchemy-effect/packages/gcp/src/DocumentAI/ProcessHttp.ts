import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Layer from "effect/Layer";
import { makeProcessorHttpBinding } from "./BindingHttp.ts";
import { Process } from "./Process.ts";

/**
 * HTTP implementation of {@link Process}.
 *
 * @layer
 * @provides GCP.DocumentAI.Process
 */
export const ProcessHttp = Layer.effect(
  Process,
  makeProcessorHttpBinding({
    tag: "GCP.DocumentAI.Process",
    operation: documentai.processProjectsLocationsProcessors,
    iam: { role: "roles/documentai.apiUser" },
  }),
);

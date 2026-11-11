import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Layer from "effect/Layer";
import { makeProcessorHttpBinding } from "./BindingHttp.ts";
import { GetProcessor } from "./GetProcessor.ts";

/**
 * HTTP implementation of {@link GetProcessor}.
 *
 * @layer
 * @provides GCP.DocumentAI.GetProcessor
 */
export const GetProcessorHttp = Layer.effect(
  GetProcessor,
  makeProcessorHttpBinding({
    tag: "GCP.DocumentAI.GetProcessor",
    operation: documentai.getProjectsLocationsProcessors,
    iam: { role: "roles/documentai.viewer" },
  }),
);

import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Layer from "effect/Layer";
import { makeSchemaHttpBinding } from "./BindingHttp.ts";
import { GetSchema } from "./GetSchema.ts";

/**
 * HTTP implementation of {@link GetSchema}.
 *
 * @layer
 * @provides GCP.DocumentAI.GetSchema
 */
export const GetSchemaHttp = Layer.effect(
  GetSchema,
  makeSchemaHttpBinding({
    tag: "GCP.DocumentAI.GetSchema",
    operation: documentai.getProjectsLocationsSchemas,
    iam: { role: "roles/documentai.viewer" },
  }),
);

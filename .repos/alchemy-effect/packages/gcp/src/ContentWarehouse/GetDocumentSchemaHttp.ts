import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Layer from "effect/Layer";
import { makeDocumentSchemaHttpBinding } from "./BindingHttp.ts";
import { GetDocumentSchema } from "./GetDocumentSchema.ts";

/**
 * HTTP implementation of {@link GetDocumentSchema}.
 *
 * @layer
 * @provides GCP.ContentWarehouse.GetDocumentSchema
 */
export const GetDocumentSchemaHttp = Layer.effect(
  GetDocumentSchema,
  makeDocumentSchemaHttpBinding({
    tag: "GCP.ContentWarehouse.GetDocumentSchema",
    operation: cw.getProjectsLocationsDocumentSchemas,
    iam: { role: "roles/contentwarehouse.documentSchemaViewer" },
  }),
);

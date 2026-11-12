import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Layer from "effect/Layer";
import { makeDocumentHttpBinding } from "./BindingHttp.ts";
import { GetDocument } from "./GetDocument.ts";

/**
 * HTTP implementation of {@link GetDocument}.
 *
 * @layer
 * @provides GCP.ContentWarehouse.GetDocument
 */
export const GetDocumentHttp = Layer.effect(
  GetDocument,
  makeDocumentHttpBinding({
    tag: "GCP.ContentWarehouse.GetDocument",
    operation: cw.getProjectsLocationsDocuments,
    iam: { role: "roles/contentwarehouse.documentViewer" },
  }),
);

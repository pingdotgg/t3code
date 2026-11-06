import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Layer from "effect/Layer";
import { makeDocumentHttpBinding } from "./DocumentHttp.ts";
import { GetDocument } from "./GetDocument.ts";

/**
 * HTTP implementation of {@link GetDocument}.
 *
 * @layer
 * @provides GCP.Firestore.GetDocument
 */
export const GetDocumentHttp = Layer.effect(
  GetDocument,
  makeDocumentHttpBinding({
    tag: "GCP.Firestore.GetDocument",
    iam: { role: "roles/datastore.viewer", scopeByCondition: true },
    operation: firestore.getProjectsDatabasesDocuments,
  }),
);

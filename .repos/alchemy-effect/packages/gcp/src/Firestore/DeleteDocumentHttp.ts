import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Layer from "effect/Layer";
import { DeleteDocument } from "./DeleteDocument.ts";
import { makeDocumentHttpBinding } from "./DocumentHttp.ts";

/**
 * HTTP implementation of {@link DeleteDocument}.
 *
 * @layer
 * @provides GCP.Firestore.DeleteDocument
 */
export const DeleteDocumentHttp = Layer.effect(
  DeleteDocument,
  makeDocumentHttpBinding({
    tag: "GCP.Firestore.DeleteDocument",
    iam: { role: "roles/datastore.user", scopeByCondition: true },
    operation: firestore.deleteProjectsDatabasesDocuments,
  }),
);

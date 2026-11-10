import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Layer from "effect/Layer";
import { makeDocumentHttpBinding } from "./DocumentHttp.ts";
import { PatchDocument } from "./PatchDocument.ts";

/**
 * HTTP implementation of {@link PatchDocument}.
 *
 * @layer
 * @provides GCP.Firestore.PatchDocument
 */
export const PatchDocumentHttp = Layer.effect(
  PatchDocument,
  makeDocumentHttpBinding({
    tag: "GCP.Firestore.PatchDocument",
    iam: { role: "roles/datastore.user", scopeByCondition: true },
    operation: firestore.patchProjectsDatabasesDocuments,
  }),
);

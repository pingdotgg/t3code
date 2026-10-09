import type * as firestore from "@distilled.cloud/gcp/firestore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "./Database.ts";

export interface PatchDocumentRequest extends Omit<
  firestore.PatchProjectsDatabasesDocumentsRequest,
  "name"
> {
  /**
   * Document path relative to the database, e.g. `users/alice`. Creates
   * the document if it does not exist unless `currentDocument.exists` is
   * set.
   */
  documentPath: string;
}

/**
 * Runtime binding for Firestore `documents.patch`.
 *
 * Bind this operation to a {@link Database} in a Function/Action init
 * phase. Provide {@link PatchDocumentHttp}. Patch upserts unless a
 * current-document precondition is set.
 *
 * ### Writing Documents
 * **Example:** Upsert a document
 * ```typescript
 * const patchDocument = yield* GCP.Firestore.PatchDocument(database);
 * yield* patchDocument({
 *   documentPath: "users/alice",
 *   body: { fields: { name: { stringValue: "Alice" } } },
 * });
 * ```
 *
 * @binding
 * @category Firestore
 */
export interface PatchDocument extends Binding.Service<
  PatchDocument,
  "GCP.Firestore.PatchDocument",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: PatchDocumentRequest,
    ) => Effect.Effect<
      firestore.Document,
      firestore.PatchProjectsDatabasesDocumentsError,
      RuntimeContext
    >
  >
> {}

export const PatchDocument = Binding.Service<PatchDocument>(
  "GCP.Firestore.PatchDocument",
);

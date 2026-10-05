import type * as firestore from "@distilled.cloud/gcp/firestore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "./Database.ts";

export interface DeleteDocumentRequest extends Omit<
  firestore.DeleteProjectsDatabasesDocumentsRequest,
  "name"
> {
  /**
   * Document path relative to the database, e.g. `users/alice`.
   */
  documentPath: string;
}

/**
 * Runtime binding for Firestore `documents.delete`.
 *
 * Bind this operation to a {@link Database} in a Function/Action init
 * phase. Provide {@link DeleteDocumentHttp}.
 *
 * ### Deleting Documents
 * **Example:** Delete a document
 * ```typescript
 * const deleteDocument = yield* GCP.Firestore.DeleteDocument(database);
 * yield* deleteDocument({ documentPath: "users/alice" });
 * ```
 *
 * @binding
 * @category Firestore
 */
export interface DeleteDocument extends Binding.Service<
  DeleteDocument,
  "GCP.Firestore.DeleteDocument",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: DeleteDocumentRequest,
    ) => Effect.Effect<
      firestore.Empty,
      firestore.DeleteProjectsDatabasesDocumentsError,
      RuntimeContext
    >
  >
> {}

export const DeleteDocument = Binding.Service<DeleteDocument>(
  "GCP.Firestore.DeleteDocument",
);

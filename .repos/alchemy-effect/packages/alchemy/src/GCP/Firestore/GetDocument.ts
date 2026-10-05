import type * as firestore from "@distilled.cloud/gcp/firestore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "./Database.ts";

export interface GetDocumentRequest extends Omit<
  firestore.GetProjectsDatabasesDocumentsRequest,
  "name"
> {
  /**
   * Document path relative to the database, e.g. `users/alice`.
   */
  documentPath: string;
}

/**
 * Runtime binding for Firestore `documents.get`.
 *
 * Bind this operation to a {@link Database} in a Function/Action init
 * phase. Provide {@link GetDocumentHttp}.
 *
 * ### Reading Documents
 * **Example:** Get a document
 * ```typescript
 * const getDocument = yield* GCP.Firestore.GetDocument(database);
 * const doc = yield* getDocument({ documentPath: "users/alice" });
 * ```
 *
 * @binding
 * @category Firestore
 */
export interface GetDocument extends Binding.Service<
  GetDocument,
  "GCP.Firestore.GetDocument",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: GetDocumentRequest,
    ) => Effect.Effect<
      firestore.Document,
      firestore.GetProjectsDatabasesDocumentsError,
      RuntimeContext
    >
  >
> {}

export const GetDocument = Binding.Service<GetDocument>(
  "GCP.Firestore.GetDocument",
);

import type * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Document } from "./Document.ts";

export interface GetDocumentRequest extends Omit<cw.GetProjectsLocationsDocumentsRequest, "name"> {}

/**
 * Runtime binding for Document AI Warehouse `documents.get`.
 *
 * Bind this operation to a {@link Document} in a Function/Action init
 * phase. Provide {@link GetDocumentHttp}.
 *
 * ### Reading Documents
 * **Example:** Read the bound document
 * ```typescript
 * const getDocument = yield* GCP.ContentWarehouse.GetDocument(document);
 * const live = yield* getDocument();
 * ```
 *
 * @binding
 * @category ContentWarehouse
 */
export interface GetDocument extends Binding.Service<
  GetDocument,
  "GCP.ContentWarehouse.GetDocument",
  (
    document: Document,
  ) => Effect.Effect<
    (
      request?: GetDocumentRequest,
    ) => Effect.Effect<
      cw.GoogleCloudContentwarehouseV1Document,
      cw.GetProjectsLocationsDocumentsError,
      RuntimeContext
    >
  >
> {}

export const GetDocument = Binding.Service<GetDocument>("GCP.ContentWarehouse.GetDocument");

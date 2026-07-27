import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `GetDocumentContent` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface GetDocumentContentRequest extends Omit<
  qbusiness.GetDocumentContentRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `GetDocumentContent` operation (IAM action
 * `qbusiness:GetDocumentContent`), scoped to one {@link Index}.
 *
 * Returns a presigned URL for an indexed document's content, in the
 * raw uploaded format or the extracted text.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.GetDocumentContentHttp)`.
 *
 * @binding
 * @section Document Ingestion
 * @example Fetch a Document's Content
 * ```typescript
 * const getContent = yield* AWS.QBusiness.GetDocumentContent(index);
 *
 * const { presignedUrl } = yield* getContent({ documentId: "welcome" });
 * ```
 */
export interface GetDocumentContent extends Binding.Service<
  GetDocumentContent,
  "AWS.QBusiness.GetDocumentContent",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: GetDocumentContentRequest,
    ) => Effect.Effect<
      qbusiness.GetDocumentContentResponse,
      qbusiness.GetDocumentContentError
    >
  >
> {}
export const GetDocumentContent = Binding.Service<GetDocumentContent>(
  "AWS.QBusiness.GetDocumentContent",
);

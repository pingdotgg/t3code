import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `ListDocuments` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface ListDocumentsRequest extends Omit<
  qbusiness.ListDocumentsRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `ListDocuments` operation (IAM action
 * `qbusiness:ListDocuments`), scoped to one {@link Index}.
 *
 * Lists the documents the index holds and their ingestion status.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListDocumentsHttp)`.
 *
 * @binding
 * @section Document Ingestion
 * @example List Indexed Documents
 * ```typescript
 * const listDocuments = yield* AWS.QBusiness.ListDocuments(index);
 *
 * const { documentDetailList } = yield* listDocuments();
 * ```
 */
export interface ListDocuments extends Binding.Service<
  ListDocuments,
  "AWS.QBusiness.ListDocuments",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request?: ListDocumentsRequest,
    ) => Effect.Effect<
      qbusiness.ListDocumentsResponse,
      qbusiness.ListDocumentsError
    >
  >
> {}
export const ListDocuments = Binding.Service<ListDocuments>(
  "AWS.QBusiness.ListDocuments",
);

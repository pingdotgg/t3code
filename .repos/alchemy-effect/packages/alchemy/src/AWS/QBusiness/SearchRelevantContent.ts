import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `SearchRelevantContent` request with `applicationId` injected from the bound application.
 */
export interface SearchRelevantContentRequest extends Omit<
  qbusiness.SearchRelevantContentRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `SearchRelevantContent` operation (IAM action
 * `qbusiness:SearchRelevantContent`), scoped to one {@link Application}.
 *
 * Searches an application's indexed content through a retriever and
 * returns the relevant passages without generating an answer — the
 * RAG retrieval half on its own.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.SearchRelevantContentHttp)`.
 *
 * @binding
 * @section Content Retrieval
 * @example Retrieve Relevant Passages
 * ```typescript
 * const search = yield* AWS.QBusiness.SearchRelevantContent(app);
 *
 * const results = yield* search({
 *   queryText: "expense reimbursement deadline",
 *   contentSource: { retriever: { retrieverId: retriever.retrieverId } },
 * });
 * ```
 */
export interface SearchRelevantContent extends Binding.Service<
  SearchRelevantContent,
  "AWS.QBusiness.SearchRelevantContent",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: SearchRelevantContentRequest,
    ) => Effect.Effect<
      qbusiness.SearchRelevantContentResponse,
      qbusiness.SearchRelevantContentError
    >
  >
> {}
export const SearchRelevantContent = Binding.Service<SearchRelevantContent>(
  "AWS.QBusiness.SearchRelevantContent",
);

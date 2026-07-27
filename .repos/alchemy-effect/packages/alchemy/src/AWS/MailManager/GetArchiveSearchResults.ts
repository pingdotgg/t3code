import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:GetArchiveSearchResults`.
 *
 * Fetches the result rows of a completed archive search (by
 * `SearchId`): sender, subject, envelope, and the `ArchivedMessageId`
 * used to download each message. IAM access is granted on the bound
 * archive's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.GetArchiveSearchResultsHttp)`.
 * @binding
 * @section Searching the Archive
 * @example Read Search Results
 * ```typescript
 * const getSearchResults = yield* MailManager.GetArchiveSearchResults(archive);
 *
 * // runtime
 * const { Rows } = yield* getSearchResults({ SearchId });
 * ```
 */
export interface GetArchiveSearchResults extends Binding.Service<
  GetArchiveSearchResults,
  "AWS.MailManager.GetArchiveSearchResults",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: mm.GetArchiveSearchResultsRequest,
    ) => Effect.Effect<
      mm.GetArchiveSearchResultsResponse,
      mm.GetArchiveSearchResultsError
    >
  >
> {}
export const GetArchiveSearchResults = Binding.Service<GetArchiveSearchResults>(
  "AWS.MailManager.GetArchiveSearchResults",
);

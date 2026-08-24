import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:StartArchiveSearch`.
 *
 * Starts an asynchronous search of the bound archive over a time window
 * with optional filters, returning a `SearchId` to poll. The archive id
 * is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MailManager.StartArchiveSearchHttp)`.
 * @binding
 * @section Searching the Archive
 * @example Search the Last 24 Hours
 * ```typescript
 * const startSearch = yield* MailManager.StartArchiveSearch(archive);
 *
 * // runtime
 * const { SearchId } = yield* startSearch({
 *   FromTimestamp: new Date(Date.now() - 86_400_000),
 *   ToTimestamp: new Date(),
 *   MaxResults: 100,
 * });
 * ```
 */
export interface StartArchiveSearch extends Binding.Service<
  StartArchiveSearch,
  "AWS.MailManager.StartArchiveSearch",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: Omit<mm.StartArchiveSearchRequest, "ArchiveId">,
    ) => Effect.Effect<
      mm.StartArchiveSearchResponse,
      mm.StartArchiveSearchError
    >
  >
> {}
export const StartArchiveSearch = Binding.Service<StartArchiveSearch>(
  "AWS.MailManager.StartArchiveSearch",
);

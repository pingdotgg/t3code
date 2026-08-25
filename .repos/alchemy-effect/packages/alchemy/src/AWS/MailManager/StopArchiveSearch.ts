import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:StopArchiveSearch`.
 *
 * Cancels a queued or running archive search (by `SearchId`). IAM
 * access is granted on the bound archive's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.StopArchiveSearchHttp)`.
 * @binding
 * @section Searching the Archive
 * @example Cancel a Search
 * ```typescript
 * const stopSearch = yield* MailManager.StopArchiveSearch(archive);
 *
 * // runtime
 * yield* stopSearch({ SearchId });
 * ```
 */
export interface StopArchiveSearch extends Binding.Service<
  StopArchiveSearch,
  "AWS.MailManager.StopArchiveSearch",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: mm.StopArchiveSearchRequest,
    ) => Effect.Effect<mm.StopArchiveSearchResponse, mm.StopArchiveSearchError>
  >
> {}
export const StopArchiveSearch = Binding.Service<StopArchiveSearch>(
  "AWS.MailManager.StopArchiveSearch",
);

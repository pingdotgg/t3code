import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:GetArchiveSearch`.
 *
 * Fetches the parameters and status of an archive search (by
 * `SearchId`). IAM access is granted on the bound archive's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.GetArchiveSearchHttp)`.
 * @binding
 * @section Searching the Archive
 * @example Poll a Search Until It Completes
 * ```typescript
 * const getSearch = yield* MailManager.GetArchiveSearch(archive);
 *
 * // runtime
 * const search = yield* getSearch({ SearchId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (s) => s.Status?.State === "COMPLETED" || s.Status?.State === "FAILED",
 *     times: 30,
 *   }),
 * );
 * ```
 */
export interface GetArchiveSearch extends Binding.Service<
  GetArchiveSearch,
  "AWS.MailManager.GetArchiveSearch",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: mm.GetArchiveSearchRequest,
    ) => Effect.Effect<mm.GetArchiveSearchResponse, mm.GetArchiveSearchError>
  >
> {}
export const GetArchiveSearch = Binding.Service<GetArchiveSearch>(
  "AWS.MailManager.GetArchiveSearch",
);

import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:ListArchiveSearches`.
 *
 * Lists the recent searches of the bound archive. The archive id is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MailManager.ListArchiveSearchesHttp)`.
 * @binding
 * @section Searching the Archive
 * @example List Recent Searches
 * ```typescript
 * const listSearches = yield* MailManager.ListArchiveSearches(archive);
 *
 * // runtime
 * const { Searches } = yield* listSearches({});
 * ```
 */
export interface ListArchiveSearches extends Binding.Service<
  ListArchiveSearches,
  "AWS.MailManager.ListArchiveSearches",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: Omit<mm.ListArchiveSearchesRequest, "ArchiveId">,
    ) => Effect.Effect<
      mm.ListArchiveSearchesResponse,
      mm.ListArchiveSearchesError
    >
  >
> {}
export const ListArchiveSearches = Binding.Service<ListArchiveSearches>(
  "AWS.MailManager.ListArchiveSearches",
);

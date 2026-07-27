import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:ListArchiveExports`.
 *
 * Lists the recent exports of the bound archive. The archive id is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MailManager.ListArchiveExportsHttp)`.
 * @binding
 * @section Exporting from the Archive
 * @example List Recent Exports
 * ```typescript
 * const listExports = yield* MailManager.ListArchiveExports(archive);
 *
 * // runtime
 * const { Exports } = yield* listExports({});
 * ```
 */
export interface ListArchiveExports extends Binding.Service<
  ListArchiveExports,
  "AWS.MailManager.ListArchiveExports",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: Omit<mm.ListArchiveExportsRequest, "ArchiveId">,
    ) => Effect.Effect<
      mm.ListArchiveExportsResponse,
      mm.ListArchiveExportsError
    >
  >
> {}
export const ListArchiveExports = Binding.Service<ListArchiveExports>(
  "AWS.MailManager.ListArchiveExports",
);

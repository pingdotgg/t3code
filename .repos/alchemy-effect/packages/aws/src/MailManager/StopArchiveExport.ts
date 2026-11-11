import type * as mm from "@distilled.cloud/aws/mailmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:StopArchiveExport`.
 *
 * Cancels a queued or running archive export (by `ExportId`). IAM
 * access is granted on the bound archive's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.StopArchiveExportHttp)`.
 * ### Exporting from the Archive
 * **Example:** Cancel an Export
 * ```typescript
 * const stopExport = yield* MailManager.StopArchiveExport(archive);
 *
 * // runtime
 * yield* stopExport({ ExportId });
 * ```
 *
 * @binding
 */
export interface StopArchiveExport extends Binding.Service<
  StopArchiveExport,
  "AWS.MailManager.StopArchiveExport",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: mm.StopArchiveExportRequest,
    ) => Effect.Effect<mm.StopArchiveExportResponse, mm.StopArchiveExportError>
  >
> {}
export const StopArchiveExport = Binding.Service<StopArchiveExport>(
  "AWS.MailManager.StopArchiveExport",
);

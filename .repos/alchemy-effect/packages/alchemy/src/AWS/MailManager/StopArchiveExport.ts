import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:StopArchiveExport`.
 *
 * Cancels a queued or running archive export (by `ExportId`). IAM
 * access is granted on the bound archive's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.StopArchiveExportHttp)`.
 * @binding
 * @section Exporting from the Archive
 * @example Cancel an Export
 * ```typescript
 * const stopExport = yield* MailManager.StopArchiveExport(archive);
 *
 * // runtime
 * yield* stopExport({ ExportId });
 * ```
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

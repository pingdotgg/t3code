import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:GetArchiveExport`.
 *
 * Fetches the parameters and status of an archive export (by
 * `ExportId`). IAM access is granted on the bound archive's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.GetArchiveExportHttp)`.
 * @binding
 * @section Exporting from the Archive
 * @example Poll an Export
 * ```typescript
 * const getExport = yield* MailManager.GetArchiveExport(archive);
 *
 * // runtime
 * const status = yield* getExport({ ExportId });
 * ```
 */
export interface GetArchiveExport extends Binding.Service<
  GetArchiveExport,
  "AWS.MailManager.GetArchiveExport",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: mm.GetArchiveExportRequest,
    ) => Effect.Effect<mm.GetArchiveExportResponse, mm.GetArchiveExportError>
  >
> {}
export const GetArchiveExport = Binding.Service<GetArchiveExport>(
  "AWS.MailManager.GetArchiveExport",
);

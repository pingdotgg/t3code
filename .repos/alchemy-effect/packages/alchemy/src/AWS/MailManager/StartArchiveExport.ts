import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:StartArchiveExport`.
 *
 * Starts an asynchronous export of messages from the bound archive to
 * an S3 bucket, returning an `ExportId` to poll. The archive id is
 * injected from the binding. The function also needs `s3:PutObject` on
 * the destination. Provide the implementation with
 * `Effect.provide(AWS.MailManager.StartArchiveExportHttp)`.
 * @binding
 * @section Exporting from the Archive
 * @example Export a Day of Mail to S3
 * ```typescript
 * const startExport = yield* MailManager.StartArchiveExport(archive);
 *
 * // runtime
 * const { ExportId } = yield* startExport({
 *   FromTimestamp: new Date(Date.now() - 86_400_000),
 *   ToTimestamp: new Date(),
 *   ExportDestinationConfiguration: {
 *     S3: { S3Location: "s3://my-export-bucket/mail/" },
 *   },
 * });
 * ```
 */
export interface StartArchiveExport extends Binding.Service<
  StartArchiveExport,
  "AWS.MailManager.StartArchiveExport",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: Omit<mm.StartArchiveExportRequest, "ArchiveId">,
    ) => Effect.Effect<
      mm.StartArchiveExportResponse,
      mm.StartArchiveExportError
    >
  >
> {}
export const StartArchiveExport = Binding.Service<StartArchiveExport>(
  "AWS.MailManager.StartArchiveExport",
);

import type * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Export } from "./Export.ts";

/**
 * Runtime binding for `bcm-data-exports:GetExport`.
 *
 * Bind this operation to an {@link Export} to read the export's live
 * definition — SQL query, table configurations, S3 destination, and refresh
 * cadence — from inside a function runtime. Useful for cost dashboards that
 * surface where their billing data lands. Provide the implementation with
 * `Effect.provide(AWS.BCMDataExports.GetExportHttp)`.
 * @binding
 * @section Inspecting an Export
 * @example Read the Export's Definition
 * ```typescript
 * // init — bind the operation to the export
 * const getExport = yield* AWS.BCMDataExports.GetExport(cur);
 *
 * // runtime
 * const { Export: definition } = yield* getExport();
 * const bucket = definition?.DestinationConfigurations.S3Destination.S3Bucket;
 * ```
 */
export interface GetExport extends Binding.Service<
  GetExport,
  "AWS.BCMDataExports.GetExport",
  (
    dataExport: Export,
  ) => Effect.Effect<
    () => Effect.Effect<bcm.GetExportResponse, bcm.GetExportError>
  >
> {}

export const GetExport = Binding.Service<GetExport>(
  "AWS.BCMDataExports.GetExport",
);

import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:CancelSbomExport`.
 *
 * Cancels a software bill of materials (SBOM) report.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.CancelSbomExportHttp)`.
 * @binding
 * @section Findings Reports & SBOM Exports
 * @example Cancel an SBOM Export
 * ```typescript
 * // init
 * const cancelSbomExport = yield* AWS.Inspector2.CancelSbomExport();
 *
 * // runtime
 * yield* cancelSbomExport({ reportId });
 * ```
 */
export interface CancelSbomExport extends Binding.Service<
  CancelSbomExport,
  "AWS.Inspector2.CancelSbomExport",
  () => Effect.Effect<
    (
      request: inspector2.CancelSbomExportRequest,
    ) => Effect.Effect<
      inspector2.CancelSbomExportResponse,
      inspector2.CancelSbomExportError
    >
  >
> {}
export const CancelSbomExport = Binding.Service<CancelSbomExport>(
  "AWS.Inspector2.CancelSbomExport",
);

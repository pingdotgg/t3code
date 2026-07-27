import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetSbomExport`.
 *
 * Gets details of a software bill of materials (SBOM) report.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetSbomExportHttp)`.
 * @binding
 * @section Findings Reports & SBOM Exports
 * @example Poll an SBOM Export
 * ```typescript
 * // init
 * const getSbomExport = yield* AWS.Inspector2.GetSbomExport();
 *
 * // runtime
 * const { status } = yield* getSbomExport({ reportId });
 * ```
 */
export interface GetSbomExport extends Binding.Service<
  GetSbomExport,
  "AWS.Inspector2.GetSbomExport",
  () => Effect.Effect<
    (
      request: inspector2.GetSbomExportRequest,
    ) => Effect.Effect<
      inspector2.GetSbomExportResponse,
      inspector2.GetSbomExportError
    >
  >
> {}
export const GetSbomExport = Binding.Service<GetSbomExport>(
  "AWS.Inspector2.GetSbomExport",
);

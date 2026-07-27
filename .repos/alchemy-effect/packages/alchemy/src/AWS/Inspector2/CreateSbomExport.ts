import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:CreateSbomExport`.
 *
 * Creates a software bill of materials (SBOM) report.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.CreateSbomExportHttp)`.
 * @binding
 * @section Findings Reports & SBOM Exports
 * @example Export an SBOM
 * ```typescript
 * // init
 * const createSbomExport = yield* AWS.Inspector2.CreateSbomExport();
 *
 * // runtime
 * const { reportId } = yield* createSbomExport({
 *   reportFormat: "SPDX_2_3",
 *   s3Destination: { bucketName, keyPrefix: "sbom/", kmsKeyArn },
 * });
 * ```
 */
export interface CreateSbomExport extends Binding.Service<
  CreateSbomExport,
  "AWS.Inspector2.CreateSbomExport",
  () => Effect.Effect<
    (
      request: inspector2.CreateSbomExportRequest,
    ) => Effect.Effect<
      inspector2.CreateSbomExportResponse,
      inspector2.CreateSbomExportError
    >
  >
> {}
export const CreateSbomExport = Binding.Service<CreateSbomExport>(
  "AWS.Inspector2.CreateSbomExport",
);

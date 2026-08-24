import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VariantStore } from "./VariantStore.ts";

export interface StartVariantImportJobRequest extends Omit<
  omics.StartVariantImportRequest,
  "destinationName"
> {}

/**
 * Runtime binding for `omics:StartVariantImportJob`.
 *
 * Bind this operation to a `VariantStore` to get a callable that starts a job
 * importing VCF variant files into the store — the store name is injected
 * automatically as `destinationName` and the action is granted on the bound
 * resource (with `iam:PassRole` for the HealthOmics service role). Provide the
 * implementation with `Effect.provide(AWS.Omics.StartVariantImportJobHttp)`.
 * @binding
 * @section Variant Imports
 * @example Bind StartVariantImportJob to a VariantStore
 * ```typescript
 * // init
 * const startImport = yield* AWS.Omics.StartVariantImportJob(store);
 * // runtime
 * const result = yield* startImport({
 *   roleArn,
 *   items: [{ source: "s3://my-bucket/variants.vcf" }],
 * });
 * ```
 */
export interface StartVariantImportJob extends Binding.Service<
  StartVariantImportJob,
  "AWS.Omics.StartVariantImportJob",
  (
    store: VariantStore,
  ) => Effect.Effect<
    (
      request: StartVariantImportJobRequest,
    ) => Effect.Effect<
      omics.StartVariantImportResponse,
      omics.StartVariantImportJobError
    >
  >
> {}

export const StartVariantImportJob = Binding.Service<StartVariantImportJob>(
  "AWS.Omics.StartVariantImportJob",
);

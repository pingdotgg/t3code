import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AnnotationStore } from "./AnnotationStore.ts";

export interface StartAnnotationImportJobRequest extends Omit<
  omics.StartAnnotationImportRequest,
  "destinationName"
> {}

/**
 * Runtime binding for `omics:StartAnnotationImportJob`.
 *
 * Bind this operation to an `AnnotationStore` to get a callable that starts a
 * job importing annotation files (TSV/VCF/GFF) into the store — the store name
 * is injected automatically as `destinationName` and the action is granted on
 * the bound resource (with `iam:PassRole` for the HealthOmics service role).
 * Provide the implementation with
 * `Effect.provide(AWS.Omics.StartAnnotationImportJobHttp)`.
 * @binding
 * @section Annotation Imports
 * @example Bind StartAnnotationImportJob to an AnnotationStore
 * ```typescript
 * // init
 * const startImport = yield* AWS.Omics.StartAnnotationImportJob(store);
 * // runtime
 * const result = yield* startImport({
 *   roleArn,
 *   items: [{ source: "s3://my-bucket/annotations.tsv" }],
 * });
 * ```
 */
export interface StartAnnotationImportJob extends Binding.Service<
  StartAnnotationImportJob,
  "AWS.Omics.StartAnnotationImportJob",
  (
    store: AnnotationStore,
  ) => Effect.Effect<
    (
      request: StartAnnotationImportJobRequest,
    ) => Effect.Effect<
      omics.StartAnnotationImportResponse,
      omics.StartAnnotationImportJobError
    >
  >
> {}

export const StartAnnotationImportJob =
  Binding.Service<StartAnnotationImportJob>(
    "AWS.Omics.StartAnnotationImportJob",
  );

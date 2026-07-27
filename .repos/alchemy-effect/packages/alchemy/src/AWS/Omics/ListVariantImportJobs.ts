import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListVariantImportJobsRequest
  extends omics.ListVariantImportJobsRequest {}

/**
 * Runtime binding for `omics:ListVariantImportJobs`.
 *
 * An account-level operation (no resource argument) that lists variant import
 * jobs, optionally filtered by store name or status. Provide the
 * implementation with `Effect.provide(AWS.Omics.ListVariantImportJobsHttp)`.
 * @binding
 * @section Variant Imports
 * @example Call ListVariantImportJobs
 * ```typescript
 * // init — account-level binding takes no resource
 * const listImports = yield* AWS.Omics.ListVariantImportJobs();
 * // runtime
 * const result = yield* listImports({});
 * ```
 */
export interface ListVariantImportJobs extends Binding.Service<
  ListVariantImportJobs,
  "AWS.Omics.ListVariantImportJobs",
  () => Effect.Effect<
    (
      request?: ListVariantImportJobsRequest,
    ) => Effect.Effect<
      omics.ListVariantImportJobsResponse,
      omics.ListVariantImportJobsError
    >
  >
> {}

export const ListVariantImportJobs = Binding.Service<ListVariantImportJobs>(
  "AWS.Omics.ListVariantImportJobs",
);

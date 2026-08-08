import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListAnnotationImportJobsRequest
  extends omics.ListAnnotationImportJobsRequest {}

/**
 * Runtime binding for `omics:ListAnnotationImportJobs`.
 *
 * An account-level operation (no resource argument) that lists annotation
 * import jobs, optionally filtered by store name or status. Provide the
 * implementation with `Effect.provide(AWS.Omics.ListAnnotationImportJobsHttp)`.
 * @binding
 * @section Annotation Imports
 * @example Call ListAnnotationImportJobs
 * ```typescript
 * // init — account-level binding takes no resource
 * const listImports = yield* AWS.Omics.ListAnnotationImportJobs();
 * // runtime
 * const result = yield* listImports({});
 * ```
 */
export interface ListAnnotationImportJobs extends Binding.Service<
  ListAnnotationImportJobs,
  "AWS.Omics.ListAnnotationImportJobs",
  () => Effect.Effect<
    (
      request?: ListAnnotationImportJobsRequest,
    ) => Effect.Effect<
      omics.ListAnnotationImportJobsResponse,
      omics.ListAnnotationImportJobsError
    >
  >
> {}

export const ListAnnotationImportJobs =
  Binding.Service<ListAnnotationImportJobs>(
    "AWS.Omics.ListAnnotationImportJobs",
  );

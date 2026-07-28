import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListDocumentClassificationJobs` — list the account's
 * asynchronous document classification jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example List Recent DocumentClassification Jobs
 * ```typescript
 * // init
 * const listDocumentClassificationJobs = yield* AWS.Comprehend.ListDocumentClassificationJobs();
 *
 * // runtime
 * const page = yield* listDocumentClassificationJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.DocumentClassificationJobPropertiesList
 * ```
 */
export interface ListDocumentClassificationJobs extends Binding.Service<
  ListDocumentClassificationJobs,
  "AWS.Comprehend.ListDocumentClassificationJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListDocumentClassificationJobsRequest,
    ) => Effect.Effect<
      comprehend.ListDocumentClassificationJobsResponse,
      comprehend.ListDocumentClassificationJobsError
    >
  >
> {}
export const ListDocumentClassificationJobs =
  Binding.Service<ListDocumentClassificationJobs>(
    "AWS.Comprehend.ListDocumentClassificationJobs",
  );

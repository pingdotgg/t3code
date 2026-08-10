import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:ListEntitiesDetectionV2Jobs` — list the asynchronous medical entity detection jobs you have submitted.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:ListEntitiesDetectionV2Jobs` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.ListEntitiesDetectionV2JobsHttp)`.
 *
 * @binding
 * @section Batch Entity Detection Jobs
 * @example List Submitted Jobs
 * ```typescript
 * // init
 * const listEntitiesDetectionV2Jobs = yield* AWS.ComprehendMedical.ListEntitiesDetectionV2Jobs();
 *
 * // runtime
 * const jobs = yield* listEntitiesDetectionV2Jobs({});
 * console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
 * ```
 */
export interface ListEntitiesDetectionV2Jobs extends Binding.Service<
  ListEntitiesDetectionV2Jobs,
  "AWS.ComprehendMedical.ListEntitiesDetectionV2Jobs",
  () => Effect.Effect<
    (
      request: comprehendmedical.ListEntitiesDetectionV2JobsRequest,
    ) => Effect.Effect<
      comprehendmedical.ListEntitiesDetectionV2JobsResponse,
      comprehendmedical.ListEntitiesDetectionV2JobsError
    >
  >
> {}
export const ListEntitiesDetectionV2Jobs =
  Binding.Service<ListEntitiesDetectionV2Jobs>(
    "AWS.ComprehendMedical.ListEntitiesDetectionV2Jobs",
  );

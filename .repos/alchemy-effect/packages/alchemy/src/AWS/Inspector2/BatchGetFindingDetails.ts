import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:BatchGetFindingDetails`.
 *
 * Gets vulnerability details for findings.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.BatchGetFindingDetailsHttp)`.
 * @binding
 * @section Querying Findings
 * @example Get Finding Details
 * ```typescript
 * // init
 * const batchGetFindingDetails = yield* AWS.Inspector2.BatchGetFindingDetails();
 *
 * // runtime
 * const { findingDetails } = yield* batchGetFindingDetails({ findingArns: [findingArn] });
 * ```
 */
export interface BatchGetFindingDetails extends Binding.Service<
  BatchGetFindingDetails,
  "AWS.Inspector2.BatchGetFindingDetails",
  () => Effect.Effect<
    (
      request: inspector2.BatchGetFindingDetailsRequest,
    ) => Effect.Effect<
      inspector2.BatchGetFindingDetailsResponse,
      inspector2.BatchGetFindingDetailsError
    >
  >
> {}
export const BatchGetFindingDetails = Binding.Service<BatchGetFindingDetails>(
  "AWS.Inspector2.BatchGetFindingDetails",
);

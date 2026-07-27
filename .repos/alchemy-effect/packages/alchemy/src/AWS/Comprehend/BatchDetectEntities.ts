import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:BatchDetectEntities` — detect named entities for a batch of up to 25 documents in a single call.
 *
 * The response carries a `ResultList` (index-aligned with `TextList`) and an
 * `ErrorList` for documents that could not be processed. Like all Comprehend
 * real-time APIs the action has no resource-level IAM, so the binding takes
 * no arguments and grants the action on `*`.
 *
 * @binding
 * @section Batch Real-Time Analysis
 * @example Entities for a Batch of Documents
 * ```typescript
 * // init
 * const batchDetectEntities = yield* AWS.Comprehend.BatchDetectEntities();
 *
 * // runtime
 * const result = yield* batchDetectEntities({
 *   TextList: ["I love this product!", "The delivery was late."],
 *   LanguageCode: "en",
 * });
 * // result.ResultList[0].Entities
 * ```
 */
export interface BatchDetectEntities extends Binding.Service<
  BatchDetectEntities,
  "AWS.Comprehend.BatchDetectEntities",
  () => Effect.Effect<
    (
      request: comprehend.BatchDetectEntitiesRequest,
    ) => Effect.Effect<
      comprehend.BatchDetectEntitiesResponse,
      comprehend.BatchDetectEntitiesError
    >
  >
> {}
export const BatchDetectEntities = Binding.Service<BatchDetectEntities>(
  "AWS.Comprehend.BatchDetectEntities",
);

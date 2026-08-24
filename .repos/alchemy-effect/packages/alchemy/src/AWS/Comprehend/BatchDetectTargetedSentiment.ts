import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:BatchDetectTargetedSentiment` — analyze entity-level (targeted) sentiment for a batch of up to 25 documents in a single call.
 *
 * The response carries a `ResultList` (index-aligned with `TextList`) and an
 * `ErrorList` for documents that could not be processed. Like all Comprehend
 * real-time APIs the action has no resource-level IAM, so the binding takes
 * no arguments and grants the action on `*`.
 *
 * @binding
 * @section Batch Real-Time Analysis
 * @example TargetedSentiment for a Batch of Documents
 * ```typescript
 * // init
 * const batchDetectTargetedSentiment = yield* AWS.Comprehend.BatchDetectTargetedSentiment();
 *
 * // runtime
 * const result = yield* batchDetectTargetedSentiment({
 *   TextList: ["I love this product!", "The delivery was late."],
 *   LanguageCode: "en",
 * });
 * // result.ResultList[0].Entities[…].Mentions
 * ```
 */
export interface BatchDetectTargetedSentiment extends Binding.Service<
  BatchDetectTargetedSentiment,
  "AWS.Comprehend.BatchDetectTargetedSentiment",
  () => Effect.Effect<
    (
      request: comprehend.BatchDetectTargetedSentimentRequest,
    ) => Effect.Effect<
      comprehend.BatchDetectTargetedSentimentResponse,
      comprehend.BatchDetectTargetedSentimentError
    >
  >
> {}
export const BatchDetectTargetedSentiment =
  Binding.Service<BatchDetectTargetedSentiment>(
    "AWS.Comprehend.BatchDetectTargetedSentiment",
  );

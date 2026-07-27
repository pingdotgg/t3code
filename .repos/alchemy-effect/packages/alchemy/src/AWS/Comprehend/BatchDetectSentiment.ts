import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:BatchDetectSentiment` — infer the prevailing sentiment for a batch of up to 25 documents in a single call.
 *
 * The response carries a `ResultList` (index-aligned with `TextList`) and an
 * `ErrorList` for documents that could not be processed. Like all Comprehend
 * real-time APIs the action has no resource-level IAM, so the binding takes
 * no arguments and grants the action on `*`.
 *
 * @binding
 * @section Batch Real-Time Analysis
 * @example Sentiment for a Batch of Documents
 * ```typescript
 * // init
 * const batchDetectSentiment = yield* AWS.Comprehend.BatchDetectSentiment();
 *
 * // runtime
 * const result = yield* batchDetectSentiment({
 *   TextList: ["I love this product!", "The delivery was late."],
 *   LanguageCode: "en",
 * });
 * // result.ResultList[0].Sentiment === "POSITIVE"
 * ```
 */
export interface BatchDetectSentiment extends Binding.Service<
  BatchDetectSentiment,
  "AWS.Comprehend.BatchDetectSentiment",
  () => Effect.Effect<
    (
      request: comprehend.BatchDetectSentimentRequest,
    ) => Effect.Effect<
      comprehend.BatchDetectSentimentResponse,
      comprehend.BatchDetectSentimentError
    >
  >
> {}
export const BatchDetectSentiment = Binding.Service<BatchDetectSentiment>(
  "AWS.Comprehend.BatchDetectSentiment",
);

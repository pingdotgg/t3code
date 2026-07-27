import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DetectSentiment` — infer the prevailing
 * sentiment of a piece of text (`POSITIVE`, `NEGATIVE`, `NEUTRAL`, or
 * `MIXED`).
 *
 * Comprehend's synchronous detect APIs are pure pay-per-call with no
 * resource to manage: the binding takes no arguments and grants the
 * function `comprehend:DetectSentiment` (the action has no resource-level
 * IAM).
 *
 * @binding
 * @section Real-Time Analysis
 * @example Detect Sentiment of a Sentence
 * ```typescript
 * // init
 * const detectSentiment = yield* AWS.Comprehend.DetectSentiment();
 *
 * // runtime
 * const result = yield* detectSentiment({
 *   Text: "I love this product, it works wonderfully!",
 *   LanguageCode: "en",
 * });
 * // result.Sentiment === "POSITIVE"
 * // result.SentimentScore.Positive ~ 0.99
 * ```
 */
export interface DetectSentiment extends Binding.Service<
  DetectSentiment,
  "AWS.Comprehend.DetectSentiment",
  () => Effect.Effect<
    (
      request: comprehend.DetectSentimentRequest,
    ) => Effect.Effect<
      comprehend.DetectSentimentResponse,
      comprehend.DetectSentimentError
    >
  >
> {}
export const DetectSentiment = Binding.Service<DetectSentiment>(
  "AWS.Comprehend.DetectSentiment",
);

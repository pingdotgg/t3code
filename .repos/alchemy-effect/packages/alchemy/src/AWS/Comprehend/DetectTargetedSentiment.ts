import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DetectTargetedSentiment` — analyze the
 * sentiment expressed toward each entity mentioned in the input text
 * (entity-level sentiment rather than whole-document sentiment).
 *
 * The binding takes no arguments and grants the action on `*` (the action
 * has no resource-level IAM).
 *
 * @binding
 * @section Real-Time Analysis
 * @example Sentiment per Entity
 * ```typescript
 * // init
 * const detectTargetedSentiment = yield* AWS.Comprehend.DetectTargetedSentiment();
 *
 * // runtime
 * const result = yield* detectTargetedSentiment({
 *   Text: "The screen is gorgeous but the battery life is disappointing.",
 *   LanguageCode: "en",
 * });
 * // result.Entities[…].Mentions[…].MentionSentiment.Sentiment
 * ```
 */
export interface DetectTargetedSentiment extends Binding.Service<
  DetectTargetedSentiment,
  "AWS.Comprehend.DetectTargetedSentiment",
  () => Effect.Effect<
    (
      request: comprehend.DetectTargetedSentimentRequest,
    ) => Effect.Effect<
      comprehend.DetectTargetedSentimentResponse,
      comprehend.DetectTargetedSentimentError
    >
  >
> {}
export const DetectTargetedSentiment = Binding.Service<DetectTargetedSentiment>(
  "AWS.Comprehend.DetectTargetedSentiment",
);

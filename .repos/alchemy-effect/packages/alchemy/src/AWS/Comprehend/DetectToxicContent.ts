import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DetectToxicContent` — run toxicity
 * analysis over a list of text segments; the response carries one result per
 * segment with per-label scores (profanity, hate speech, harassment, …).
 *
 * The binding takes no arguments and grants the action on `*` (the action
 * has no resource-level IAM).
 *
 * @binding
 * @section Real-Time Analysis
 * @example Score Text Segments for Toxicity
 * ```typescript
 * // init
 * const detectToxicContent = yield* AWS.Comprehend.DetectToxicContent();
 *
 * // runtime
 * const result = yield* detectToxicContent({
 *   TextSegments: [{ Text: "You are a wonderful person." }],
 *   LanguageCode: "en",
 * });
 * // result.ResultList[0].Toxicity ~ 0.01
 * ```
 */
export interface DetectToxicContent extends Binding.Service<
  DetectToxicContent,
  "AWS.Comprehend.DetectToxicContent",
  () => Effect.Effect<
    (
      request: comprehend.DetectToxicContentRequest,
    ) => Effect.Effect<
      comprehend.DetectToxicContentResponse,
      comprehend.DetectToxicContentError
    >
  >
> {}
export const DetectToxicContent = Binding.Service<DetectToxicContent>(
  "AWS.Comprehend.DetectToxicContent",
);

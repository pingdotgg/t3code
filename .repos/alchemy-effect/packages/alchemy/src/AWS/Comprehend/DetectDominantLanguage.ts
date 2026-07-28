import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DetectDominantLanguage` — determine the
 * dominant language of the input text (returns RFC 5646 language codes with
 * confidence scores).
 *
 * Comprehend's synchronous detect APIs are pure pay-per-call with no
 * resource to manage: the binding takes no arguments and grants the action
 * on `*` (it has no resource-level IAM).
 *
 * @binding
 * @section Real-Time Analysis
 * @example Detect the Language of a Document
 * ```typescript
 * // init
 * const detectDominantLanguage = yield* AWS.Comprehend.DetectDominantLanguage();
 *
 * // runtime
 * const result = yield* detectDominantLanguage({
 *   Text: "Bob ordered two sandwiches yesterday.",
 * });
 * // result.Languages[0].LanguageCode === "en"
 * ```
 */
export interface DetectDominantLanguage extends Binding.Service<
  DetectDominantLanguage,
  "AWS.Comprehend.DetectDominantLanguage",
  () => Effect.Effect<
    (
      request: comprehend.DetectDominantLanguageRequest,
    ) => Effect.Effect<
      comprehend.DetectDominantLanguageResponse,
      comprehend.DetectDominantLanguageError
    >
  >
> {}
export const DetectDominantLanguage = Binding.Service<DetectDominantLanguage>(
  "AWS.Comprehend.DetectDominantLanguage",
);

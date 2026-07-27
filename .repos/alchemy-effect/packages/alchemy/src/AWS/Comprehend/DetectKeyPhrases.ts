import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DetectKeyPhrases` — extract the key noun
 * phrases of the input text with confidence scores and offsets.
 *
 * The binding takes no arguments and grants the action on `*` (the action
 * has no resource-level IAM).
 *
 * @binding
 * @section Real-Time Analysis
 * @example Extract Key Phrases
 * ```typescript
 * // init
 * const detectKeyPhrases = yield* AWS.Comprehend.DetectKeyPhrases();
 *
 * // runtime
 * const result = yield* detectKeyPhrases({
 *   Text: "The quarterly earnings report exceeded analyst expectations.",
 *   LanguageCode: "en",
 * });
 * // result.KeyPhrases: [{ Text: "The quarterly earnings report" }, …]
 * ```
 */
export interface DetectKeyPhrases extends Binding.Service<
  DetectKeyPhrases,
  "AWS.Comprehend.DetectKeyPhrases",
  () => Effect.Effect<
    (
      request: comprehend.DetectKeyPhrasesRequest,
    ) => Effect.Effect<
      comprehend.DetectKeyPhrasesResponse,
      comprehend.DetectKeyPhrasesError
    >
  >
> {}
export const DetectKeyPhrases = Binding.Service<DetectKeyPhrases>(
  "AWS.Comprehend.DetectKeyPhrases",
);

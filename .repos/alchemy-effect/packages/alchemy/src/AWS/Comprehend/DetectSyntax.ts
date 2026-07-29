import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DetectSyntax` — tokenize the input text
 * and label each token with its part of speech (noun, verb, adjective, …).
 *
 * The binding takes no arguments and grants the action on `*` (the action
 * has no resource-level IAM).
 *
 * @binding
 * @section Real-Time Analysis
 * @example Parse Parts of Speech
 * ```typescript
 * // init
 * const detectSyntax = yield* AWS.Comprehend.DetectSyntax();
 *
 * // runtime
 * const result = yield* detectSyntax({
 *   Text: "The cat sat on the mat.",
 *   LanguageCode: "en",
 * });
 * // result.SyntaxTokens: [{ Text: "cat", PartOfSpeech: { Tag: "NOUN" } }, …]
 * ```
 */
export interface DetectSyntax extends Binding.Service<
  DetectSyntax,
  "AWS.Comprehend.DetectSyntax",
  () => Effect.Effect<
    (
      request: comprehend.DetectSyntaxRequest,
    ) => Effect.Effect<
      comprehend.DetectSyntaxResponse,
      comprehend.DetectSyntaxError
    >
  >
> {}
export const DetectSyntax = Binding.Service<DetectSyntax>(
  "AWS.Comprehend.DetectSyntax",
);

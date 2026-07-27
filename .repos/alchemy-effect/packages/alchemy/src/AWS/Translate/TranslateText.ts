import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:TranslateText` — translate text between
 * a source and a target language.
 *
 * Translate is a pure pay-per-call service with no resource to manage:
 * the binding takes no arguments and grants the function
 * `translate:TranslateText` (the action has no resource-level IAM).
 * Language codes follow RFC 5646 (`en`, `es`, `de`, ...); pass `auto` as
 * the source to let Translate detect the language (this additionally
 * calls Comprehend under the hood).
 *
 * @binding
 * @section Translating Text
 * @example Translate English to Spanish
 * ```typescript
 * // init
 * const translateText = yield* AWS.Translate.TranslateText();
 *
 * // runtime
 * const result = yield* translateText({
 *   Text: "Hello, world!",
 *   SourceLanguageCode: "en",
 *   TargetLanguageCode: "es",
 * });
 * // result.TranslatedText === "¡Hola, mundo!"
 * ```
 */
export interface TranslateText extends Binding.Service<
  TranslateText,
  "AWS.Translate.TranslateText",
  () => Effect.Effect<
    (
      request: translate.TranslateTextRequest,
    ) => Effect.Effect<
      translate.TranslateTextResponse,
      translate.TranslateTextError
    >
  >
> {}
export const TranslateText = Binding.Service<TranslateText>(
  "AWS.Translate.TranslateText",
);

import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:TranslateDocument` — synchronously
 * translate a whole document (plain text, HTML, or Word) between a source
 * and a target language.
 *
 * One of the two language codes must be `en` (English). The document
 * content and the translated result are sensitive blobs — the response's
 * `TranslatedDocument.Content` decodes as `Redacted<Uint8Array>`.
 *
 * @binding
 * @section Translating Documents
 * @example Translate a plain-text document
 * ```typescript
 * // init
 * const translateDocument = yield* AWS.Translate.TranslateDocument();
 *
 * // runtime
 * const result = yield* translateDocument({
 *   Document: {
 *     Content: new TextEncoder().encode("Good morning!"),
 *     ContentType: "text/plain",
 *   },
 *   SourceLanguageCode: "en",
 *   TargetLanguageCode: "es",
 * });
 * const bytes = Redacted.value(result.TranslatedDocument.Content as Redacted.Redacted<Uint8Array>);
 * // new TextDecoder().decode(bytes) === "¡Buenos días!"
 * ```
 */
export interface TranslateDocument extends Binding.Service<
  TranslateDocument,
  "AWS.Translate.TranslateDocument",
  () => Effect.Effect<
    (
      request: translate.TranslateDocumentRequest,
    ) => Effect.Effect<
      translate.TranslateDocumentResponse,
      translate.TranslateDocumentError
    >
  >
> {}
export const TranslateDocument = Binding.Service<TranslateDocument>(
  "AWS.Translate.TranslateDocument",
);

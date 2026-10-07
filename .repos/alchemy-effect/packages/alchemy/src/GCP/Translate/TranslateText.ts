import type * as translate from "@distilled.cloud/gcp/translate_v3";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Model } from "./Model.ts";

export interface TranslateTextRequest {
  /**
   * Request body. `model` is filled from the bound custom model.
   */
  body?: Omit<translate.TranslateTextRequest, "model">;
}

/**
 * Runtime binding for Cloud Translation `translateText` using a custom
 * AutoML model.
 *
 * Bind this operation to a {@link Model} in a Function/Action init
 * phase. Provide {@link TranslateTextHttp}.
 *
 * ### Translating with a Custom Model
 * **Example:** Translate a sentence
 * ```typescript
 * const translateText = yield* GCP.Translate.TranslateText(model);
 * const result = yield* translateText({
 *   body: {
 *     contents: ["Hello, world"],
 *     targetLanguageCode: "es",
 *     sourceLanguageCode: "en",
 *     mimeType: "text/plain",
 *   },
 * });
 * ```
 *
 * @binding
 * @category Translate
 */
export interface TranslateText extends Binding.Service<
  TranslateText,
  "GCP.Translate.TranslateText",
  (
    model: Model,
  ) => Effect.Effect<
    (
      request?: TranslateTextRequest,
    ) => Effect.Effect<
      translate.TranslateTextResponse,
      translate.TranslateTextProjectsLocationsError,
      RuntimeContext
    >
  >
> {}

export const TranslateText = Binding.Service<TranslateText>(
  "GCP.Translate.TranslateText",
);

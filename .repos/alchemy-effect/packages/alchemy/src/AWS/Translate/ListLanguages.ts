import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:ListLanguages` — list the languages
 * (RFC-5646 codes and display names) Amazon Translate supports.
 *
 * @binding
 * @section Discovering Languages
 * @example List supported languages
 * ```typescript
 * // init
 * const listLanguages = yield* AWS.Translate.ListLanguages();
 *
 * // runtime
 * const result = yield* listLanguages({ MaxResults: 100 });
 * // result.Languages -> [{ LanguageCode: "es", LanguageName: "Spanish" }, …]
 * ```
 */
export interface ListLanguages extends Binding.Service<
  ListLanguages,
  "AWS.Translate.ListLanguages",
  () => Effect.Effect<
    (
      request?: translate.ListLanguagesRequest,
    ) => Effect.Effect<
      translate.ListLanguagesResponse,
      translate.ListLanguagesError
    >
  >
> {}
export const ListLanguages = Binding.Service<ListLanguages>(
  "AWS.Translate.ListLanguages",
);

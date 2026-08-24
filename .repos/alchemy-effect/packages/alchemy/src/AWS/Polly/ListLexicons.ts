import type * as polly from "@distilled.cloud/aws/polly";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `polly:ListLexicons` — list the pronunciation
 * lexicons stored in the region (name plus attributes; use the names as
 * `LexiconNames` in synthesis requests).
 *
 * The binding takes no arguments and grants the function
 * `polly:ListLexicons`. Provide the implementation with
 * `Effect.provide(AWS.Polly.ListLexiconsHttp)`.
 *
 * @binding
 * @section Managing Lexicons
 * @example List the region's lexicons
 * ```typescript
 * // init
 * const listLexicons = yield* AWS.Polly.ListLexicons();
 *
 * // runtime
 * const result = yield* listLexicons();
 * const names = (result.Lexicons ?? []).map((lexicon) => lexicon.Name);
 * ```
 */
export interface ListLexicons extends Binding.Service<
  ListLexicons,
  "AWS.Polly.ListLexicons",
  () => Effect.Effect<
    (
      request?: polly.ListLexiconsInput,
    ) => Effect.Effect<polly.ListLexiconsOutput, polly.ListLexiconsError>
  >
> {}
export const ListLexicons = Binding.Service<ListLexicons>(
  "AWS.Polly.ListLexicons",
);

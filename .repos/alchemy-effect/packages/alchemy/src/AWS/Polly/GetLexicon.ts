import type * as polly from "@distilled.cloud/aws/polly";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Lexicon } from "./Lexicon.ts";

/**
 * Runtime binding for `polly:GetLexicon` — read the PLS content and
 * attributes of a pronunciation lexicon at runtime.
 *
 * Bind it to a `Lexicon` resource; the deploy-time half grants
 * `polly:GetLexicon` scoped to that lexicon's ARN and the runtime callable
 * injects the lexicon name. The returned `Lexicon.Content` is `Redacted`
 * (distilled models it as sensitive) — unwrap with `Redacted.value(...)` at
 * the point of use. Provide the implementation with
 * `Effect.provide(AWS.Polly.GetLexiconHttp)`.
 *
 * @binding
 * @section Managing Lexicons
 * @example Read a lexicon's content at runtime
 * ```typescript
 * // init
 * const getLexicon = yield* AWS.Polly.GetLexicon(lexicon);
 *
 * // runtime
 * const result = yield* getLexicon();
 * const content = result.Lexicon?.Content;
 * const xml =
 *   content === undefined
 *     ? undefined
 *     : Redacted.isRedacted(content)
 *       ? Redacted.value(content)
 *       : content;
 * ```
 */
export interface GetLexicon extends Binding.Service<
  GetLexicon,
  "AWS.Polly.GetLexicon",
  <L extends Lexicon>(
    lexicon: L,
  ) => Effect.Effect<
    () => Effect.Effect<polly.GetLexiconOutput, polly.GetLexiconError>
  >
> {}
export const GetLexicon = Binding.Service<GetLexicon>("AWS.Polly.GetLexicon");

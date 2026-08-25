import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:BatchDetectKeyPhrases` — extract key phrases for a batch of up to 25 documents in a single call.
 *
 * The response carries a `ResultList` (index-aligned with `TextList`) and an
 * `ErrorList` for documents that could not be processed. Like all Comprehend
 * real-time APIs the action has no resource-level IAM, so the binding takes
 * no arguments and grants the action on `*`.
 *
 * @binding
 * @section Batch Real-Time Analysis
 * @example KeyPhrases for a Batch of Documents
 * ```typescript
 * // init
 * const batchDetectKeyPhrases = yield* AWS.Comprehend.BatchDetectKeyPhrases();
 *
 * // runtime
 * const result = yield* batchDetectKeyPhrases({
 *   TextList: ["I love this product!", "The delivery was late."],
 *   LanguageCode: "en",
 * });
 * // result.ResultList[0].KeyPhrases
 * ```
 */
export interface BatchDetectKeyPhrases extends Binding.Service<
  BatchDetectKeyPhrases,
  "AWS.Comprehend.BatchDetectKeyPhrases",
  () => Effect.Effect<
    (
      request: comprehend.BatchDetectKeyPhrasesRequest,
    ) => Effect.Effect<
      comprehend.BatchDetectKeyPhrasesResponse,
      comprehend.BatchDetectKeyPhrasesError
    >
  >
> {}
export const BatchDetectKeyPhrases = Binding.Service<BatchDetectKeyPhrases>(
  "AWS.Comprehend.BatchDetectKeyPhrases",
);

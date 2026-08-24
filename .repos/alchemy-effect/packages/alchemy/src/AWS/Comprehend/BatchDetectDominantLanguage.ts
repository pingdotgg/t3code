import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:BatchDetectDominantLanguage` — determine the dominant language for a batch of up to 25 documents in a single call.
 *
 * The response carries a `ResultList` (index-aligned with `TextList`) and an
 * `ErrorList` for documents that could not be processed. Like all Comprehend
 * real-time APIs the action has no resource-level IAM, so the binding takes
 * no arguments and grants the action on `*`.
 *
 * @binding
 * @section Batch Real-Time Analysis
 * @example DominantLanguage for a Batch of Documents
 * ```typescript
 * // init
 * const batchDetectDominantLanguage = yield* AWS.Comprehend.BatchDetectDominantLanguage();
 *
 * // runtime
 * const result = yield* batchDetectDominantLanguage({
 *   TextList: ["I love this product!", "The delivery was late."],
 * });
 * // result.ResultList[0].Languages[0].LanguageCode === "en"
 * ```
 */
export interface BatchDetectDominantLanguage extends Binding.Service<
  BatchDetectDominantLanguage,
  "AWS.Comprehend.BatchDetectDominantLanguage",
  () => Effect.Effect<
    (
      request: comprehend.BatchDetectDominantLanguageRequest,
    ) => Effect.Effect<
      comprehend.BatchDetectDominantLanguageResponse,
      comprehend.BatchDetectDominantLanguageError
    >
  >
> {}
export const BatchDetectDominantLanguage =
  Binding.Service<BatchDetectDominantLanguage>(
    "AWS.Comprehend.BatchDetectDominantLanguage",
  );

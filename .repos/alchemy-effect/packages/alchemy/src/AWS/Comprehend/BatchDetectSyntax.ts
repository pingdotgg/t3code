import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:BatchDetectSyntax` — tokenize and label parts of speech for a batch of up to 25 documents in a single call.
 *
 * The response carries a `ResultList` (index-aligned with `TextList`) and an
 * `ErrorList` for documents that could not be processed. Like all Comprehend
 * real-time APIs the action has no resource-level IAM, so the binding takes
 * no arguments and grants the action on `*`.
 *
 * @binding
 * @section Batch Real-Time Analysis
 * @example Syntax for a Batch of Documents
 * ```typescript
 * // init
 * const batchDetectSyntax = yield* AWS.Comprehend.BatchDetectSyntax();
 *
 * // runtime
 * const result = yield* batchDetectSyntax({
 *   TextList: ["I love this product!", "The delivery was late."],
 *   LanguageCode: "en",
 * });
 * // result.ResultList[0].SyntaxTokens
 * ```
 */
export interface BatchDetectSyntax extends Binding.Service<
  BatchDetectSyntax,
  "AWS.Comprehend.BatchDetectSyntax",
  () => Effect.Effect<
    (
      request: comprehend.BatchDetectSyntaxRequest,
    ) => Effect.Effect<
      comprehend.BatchDetectSyntaxResponse,
      comprehend.BatchDetectSyntaxError
    >
  >
> {}
export const BatchDetectSyntax = Binding.Service<BatchDetectSyntax>(
  "AWS.Comprehend.BatchDetectSyntax",
);

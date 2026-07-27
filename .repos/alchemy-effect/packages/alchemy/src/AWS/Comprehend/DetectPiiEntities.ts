import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DetectPiiEntities` — locate personally
 * identifiable information (names, addresses, bank account numbers, …) in
 * the input text, with entity type, score, and character offsets.
 *
 * The binding takes no arguments and grants the action on `*` (the action
 * has no resource-level IAM). To only test *whether* a document contains
 * PII, use the cheaper {@link ContainsPiiEntities}.
 *
 * @binding
 * @section Real-Time Analysis
 * @example Locate PII in a Document
 * ```typescript
 * // init
 * const detectPiiEntities = yield* AWS.Comprehend.DetectPiiEntities();
 *
 * // runtime
 * const result = yield* detectPiiEntities({
 *   Text: "My name is Jane Doe and my email is jane@example.com.",
 *   LanguageCode: "en",
 * });
 * // result.Entities: [{ Type: "NAME", BeginOffset: 11, … }, { Type: "EMAIL", … }]
 * ```
 */
export interface DetectPiiEntities extends Binding.Service<
  DetectPiiEntities,
  "AWS.Comprehend.DetectPiiEntities",
  () => Effect.Effect<
    (
      request: comprehend.DetectPiiEntitiesRequest,
    ) => Effect.Effect<
      comprehend.DetectPiiEntitiesResponse,
      comprehend.DetectPiiEntitiesError
    >
  >
> {}
export const DetectPiiEntities = Binding.Service<DetectPiiEntities>(
  "AWS.Comprehend.DetectPiiEntities",
);

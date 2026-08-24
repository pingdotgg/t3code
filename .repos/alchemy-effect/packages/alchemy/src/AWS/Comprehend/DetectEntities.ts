import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DetectEntities` — detect named entities
 * (people, places, organizations, dates, quantities, …) in the input text
 * using the pre-trained model, or custom entities via a custom entity
 * recognizer endpoint (`EndpointArn`).
 *
 * The binding takes no arguments and grants the action on `*` (the action
 * has no resource-level IAM for the pre-trained model).
 *
 * @binding
 * @section Real-Time Analysis
 * @example Detect Named Entities
 * ```typescript
 * // init
 * const detectEntities = yield* AWS.Comprehend.DetectEntities();
 *
 * // runtime
 * const result = yield* detectEntities({
 *   Text: "Bob moved to Seattle in 2017.",
 *   LanguageCode: "en",
 * });
 * // result.Entities: [{ Type: "PERSON", Text: "Bob" }, { Type: "LOCATION", Text: "Seattle" }, …]
 * ```
 */
export interface DetectEntities extends Binding.Service<
  DetectEntities,
  "AWS.Comprehend.DetectEntities",
  () => Effect.Effect<
    (
      request: comprehend.DetectEntitiesRequest,
    ) => Effect.Effect<
      comprehend.DetectEntitiesResponse,
      comprehend.DetectEntitiesError
    >
  >
> {}
export const DetectEntities = Binding.Service<DetectEntities>(
  "AWS.Comprehend.DetectEntities",
);

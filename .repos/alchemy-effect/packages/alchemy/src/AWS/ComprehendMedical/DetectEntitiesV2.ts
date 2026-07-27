import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:DetectEntitiesV2` — extract medical
 * entities (medications, medical conditions, anatomy, PHI, tests/treatments)
 * and their attributes and traits from clinical text.
 *
 * Comprehend Medical is a pure pay-per-call service with no resource to
 * manage: the binding takes no arguments and grants the function
 * `comprehendmedical:DetectEntitiesV2` (the action has no resource-level
 * IAM). Pass the clinical note as raw text — no marshalling.
 *
 * @binding
 * @section Detecting Medical Entities
 * @example Detect Entities in a Clinical Note
 * ```typescript
 * // init
 * const detectEntities = yield* AWS.ComprehendMedical.DetectEntitiesV2();
 *
 * // runtime
 * const result = yield* detectEntities({
 *   Text: "Patient takes 50 mg atenolol daily for hypertension.",
 * });
 * const names = (result.Entities ?? []).map((entity) => entity.Text);
 * ```
 */
export interface DetectEntitiesV2 extends Binding.Service<
  DetectEntitiesV2,
  "AWS.ComprehendMedical.DetectEntitiesV2",
  () => Effect.Effect<
    (
      request: comprehendmedical.DetectEntitiesV2Request,
    ) => Effect.Effect<
      comprehendmedical.DetectEntitiesV2Response,
      comprehendmedical.DetectEntitiesV2Error
    >
  >
> {}
export const DetectEntitiesV2 = Binding.Service<DetectEntitiesV2>(
  "AWS.ComprehendMedical.DetectEntitiesV2",
);

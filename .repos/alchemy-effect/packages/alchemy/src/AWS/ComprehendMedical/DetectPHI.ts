import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:DetectPHI` — detect protected health
 * information (PHI) entities (name, address, age, ID numbers, dates…) in
 * clinical text.
 *
 * Comprehend Medical is a pure pay-per-call service with no resource to
 * manage: the binding takes no arguments and grants the function
 * `comprehendmedical:DetectPHI` (the action has no resource-level IAM). Pass
 * the clinical note as raw text — no marshalling.
 *
 * @binding
 * @section Detecting PHI
 * @example Detect PHI in a Clinical Note
 * ```typescript
 * // init
 * const detectPHI = yield* AWS.ComprehendMedical.DetectPHI();
 *
 * // runtime
 * const result = yield* detectPHI({
 *   Text: "John Doe, age 47, was seen on 2024-01-03.",
 * });
 * const phi = (result.Entities ?? []).map((entity) => entity.Type);
 * ```
 */
export interface DetectPHI extends Binding.Service<
  DetectPHI,
  "AWS.ComprehendMedical.DetectPHI",
  () => Effect.Effect<
    (
      request: comprehendmedical.DetectPHIRequest,
    ) => Effect.Effect<
      comprehendmedical.DetectPHIResponse,
      comprehendmedical.DetectPHIError
    >
  >
> {}
export const DetectPHI = Binding.Service<DetectPHI>(
  "AWS.ComprehendMedical.DetectPHI",
);

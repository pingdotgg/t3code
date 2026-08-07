import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:InferICD10CM` — detect medical
 * conditions in clinical text and link them to ICD-10-CM ontology codes with
 * confidence scores.
 *
 * Comprehend Medical is a pure pay-per-call service with no resource to
 * manage: the binding takes no arguments and grants the function
 * `comprehendmedical:InferICD10CM` (the action has no resource-level IAM).
 * Pass the clinical note as raw text — no marshalling.
 *
 * @binding
 * @section Inferring ICD-10-CM Codes
 * @example Infer ICD-10-CM Codes from a Clinical Note
 * ```typescript
 * // init
 * const inferICD10CM = yield* AWS.ComprehendMedical.InferICD10CM();
 *
 * // runtime
 * const result = yield* inferICD10CM({
 *   Text: "Patient presents with type 2 diabetes and hypertension.",
 * });
 * const codes = (result.Entities ?? []).flatMap((entity) =>
 *   (entity.ICD10CMConcepts ?? []).map((concept) => concept.Code),
 * );
 * ```
 */
export interface InferICD10CM extends Binding.Service<
  InferICD10CM,
  "AWS.ComprehendMedical.InferICD10CM",
  () => Effect.Effect<
    (
      request: comprehendmedical.InferICD10CMRequest,
    ) => Effect.Effect<
      comprehendmedical.InferICD10CMResponse,
      comprehendmedical.InferICD10CMError
    >
  >
> {}
export const InferICD10CM = Binding.Service<InferICD10CM>(
  "AWS.ComprehendMedical.InferICD10CM",
);

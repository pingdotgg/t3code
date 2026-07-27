import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:InferRxNorm` — detect medication entities in clinical text and link them to concept identifiers in the RxNorm ontology (medication names, dosages, frequencies).
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:InferRxNorm` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.InferRxNormHttp)`.
 *
 * @binding
 * @section Linking Medications to RxNorm
 * @example Infer RxNorm Concepts for a Medication List
 * ```typescript
 * // init
 * const inferRxNorm = yield* AWS.ComprehendMedical.InferRxNorm();
 *
 * // runtime
 * const result = yield* inferRxNorm({
 *   Text: "Patient takes 50 mg atenolol daily.",
 * });
 * const concepts = (result.Entities ?? []).flatMap((e) => e.RxNormConcepts ?? []);
 * ```
 */
export interface InferRxNorm extends Binding.Service<
  InferRxNorm,
  "AWS.ComprehendMedical.InferRxNorm",
  () => Effect.Effect<
    (
      request: comprehendmedical.InferRxNormRequest,
    ) => Effect.Effect<
      comprehendmedical.InferRxNormResponse,
      comprehendmedical.InferRxNormError
    >
  >
> {}
export const InferRxNorm = Binding.Service<InferRxNorm>(
  "AWS.ComprehendMedical.InferRxNorm",
);

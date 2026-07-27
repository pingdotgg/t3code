import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:InferSNOMEDCT` — detect medical concepts in clinical text and link them to codes in the Systematized Nomenclature of Medicine, Clinical Terms (SNOMED CT) ontology.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:InferSNOMEDCT` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.InferSNOMEDCTHttp)`.
 *
 * @binding
 * @section Linking Concepts to SNOMED CT
 * @example Infer SNOMED CT Concepts for a Clinical Note
 * ```typescript
 * // init
 * const inferSNOMEDCT = yield* AWS.ComprehendMedical.InferSNOMEDCT();
 *
 * // runtime
 * const result = yield* inferSNOMEDCT({
 *   Text: "Patient presents with type 2 diabetes.",
 * });
 * const concepts = (result.Entities ?? []).flatMap((e) => e.SNOMEDCTConcepts ?? []);
 * ```
 */
export interface InferSNOMEDCT extends Binding.Service<
  InferSNOMEDCT,
  "AWS.ComprehendMedical.InferSNOMEDCT",
  () => Effect.Effect<
    (
      request: comprehendmedical.InferSNOMEDCTRequest,
    ) => Effect.Effect<
      comprehendmedical.InferSNOMEDCTResponse,
      comprehendmedical.InferSNOMEDCTError
    >
  >
> {}
export const InferSNOMEDCT = Binding.Service<InferSNOMEDCT>(
  "AWS.ComprehendMedical.InferSNOMEDCT",
);

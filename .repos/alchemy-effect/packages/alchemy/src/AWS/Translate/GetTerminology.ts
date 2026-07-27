import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:GetTerminology` — retrieve a custom
 * terminology's properties and a presigned download location for its
 * term-pair file.
 *
 * @binding
 * @section Reading Terminologies
 * @example Read a terminology's properties
 * ```typescript
 * // init
 * const getTerminology = yield* AWS.Translate.GetTerminology();
 *
 * // runtime
 * const result = yield* getTerminology({ Name: glossary.terminologyName });
 * // result.TerminologyProperties?.TermCount
 * // result.TerminologyDataLocation?.Location — presigned download URL
 * ```
 */
export interface GetTerminology extends Binding.Service<
  GetTerminology,
  "AWS.Translate.GetTerminology",
  () => Effect.Effect<
    (
      request: translate.GetTerminologyRequest,
    ) => Effect.Effect<
      translate.GetTerminologyResponse,
      translate.GetTerminologyError
    >
  >
> {}
export const GetTerminology = Binding.Service<GetTerminology>(
  "AWS.Translate.GetTerminology",
);

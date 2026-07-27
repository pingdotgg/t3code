import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `access-analyzer:CancelPolicyGeneration`.
 *
 * Cancels an in-progress policy-generation job. Provide the implementation
 * with `Effect.provide(AWS.AccessAnalyzer.CancelPolicyGenerationHttp)`.
 * @binding
 * @section Policy Generation
 * @example Cancel a Generation Job
 * ```typescript
 * const cancelGeneration =
 *   yield* AWS.AccessAnalyzer.CancelPolicyGeneration();
 * yield* cancelGeneration({ jobId });
 * ```
 */
export interface CancelPolicyGeneration extends Binding.Service<
  CancelPolicyGeneration,
  "AWS.AccessAnalyzer.CancelPolicyGeneration",
  () => Effect.Effect<
    (
      request: aa.CancelPolicyGenerationRequest,
    ) => Effect.Effect<
      aa.CancelPolicyGenerationResponse,
      aa.CancelPolicyGenerationError
    >
  >
> {}

export const CancelPolicyGeneration = Binding.Service<CancelPolicyGeneration>(
  "AWS.AccessAnalyzer.CancelPolicyGeneration",
);

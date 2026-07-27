import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `access-analyzer:StartPolicyGeneration`.
 *
 * Starts generating a least-privilege policy for a principal from its access
 * activity (optionally a CloudTrail trail). Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.StartPolicyGenerationHttp)`.
 * @binding
 * @section Policy Generation
 * @example Generate a Policy for a Role
 * ```typescript
 * const startGeneration =
 *   yield* AWS.AccessAnalyzer.StartPolicyGeneration();
 * const { jobId } = yield* startGeneration({
 *   policyGenerationDetails: { principalArn: roleArn },
 * });
 * ```
 */
export interface StartPolicyGeneration extends Binding.Service<
  StartPolicyGeneration,
  "AWS.AccessAnalyzer.StartPolicyGeneration",
  () => Effect.Effect<
    (
      request: aa.StartPolicyGenerationRequest,
    ) => Effect.Effect<
      aa.StartPolicyGenerationResponse,
      aa.StartPolicyGenerationError
    >
  >
> {}

export const StartPolicyGeneration = Binding.Service<StartPolicyGeneration>(
  "AWS.AccessAnalyzer.StartPolicyGeneration",
);

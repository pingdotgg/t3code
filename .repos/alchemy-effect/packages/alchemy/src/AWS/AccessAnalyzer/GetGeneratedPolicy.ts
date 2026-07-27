import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `access-analyzer:GetGeneratedPolicy`.
 *
 * Retrieves the status and result of a policy-generation job started with
 * {@link StartPolicyGeneration}. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GetGeneratedPolicyHttp)`.
 * @binding
 * @section Policy Generation
 * @example Read the Generated Policy
 * ```typescript
 * const getGenerated = yield* AWS.AccessAnalyzer.GetGeneratedPolicy();
 * const generated = yield* getGenerated({ jobId });
 * ```
 */
export interface GetGeneratedPolicy extends Binding.Service<
  GetGeneratedPolicy,
  "AWS.AccessAnalyzer.GetGeneratedPolicy",
  () => Effect.Effect<
    (
      request: aa.GetGeneratedPolicyRequest,
    ) => Effect.Effect<
      aa.GetGeneratedPolicyResponse,
      aa.GetGeneratedPolicyError
    >
  >
> {}

export const GetGeneratedPolicy = Binding.Service<GetGeneratedPolicy>(
  "AWS.AccessAnalyzer.GetGeneratedPolicy",
);

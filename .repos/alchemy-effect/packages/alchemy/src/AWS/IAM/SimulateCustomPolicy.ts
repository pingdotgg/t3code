import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:SimulateCustomPolicy` — evaluate how a set of
 * candidate IAM policy documents would decide a list of actions, without
 * attaching the policies to any entity. The building block for policy
 * linters, "what would this grant?" previews, and authorization test
 * harnesses.
 *
 * The policies are supplied as strings per request, so the binding takes no
 * arguments and grants `iam:SimulateCustomPolicy` on `*`. Provide the
 * implementation with `Effect.provide(AWS.IAM.SimulateCustomPolicyHttp)`.
 *
 * @binding
 * @section Simulating Policies
 * @example Preview a Candidate Policy
 * ```typescript
 * // init
 * const simulateCustomPolicy = yield* IAM.SimulateCustomPolicy();
 *
 * // runtime
 * const { EvaluationResults } = yield* simulateCustomPolicy({
 *   PolicyInputList: [
 *     JSON.stringify({
 *       Version: "2012-10-17",
 *       Statement: [
 *         { Effect: "Allow", Action: "s3:ListAllMyBuckets", Resource: "*" },
 *       ],
 *     }),
 *   ],
 *   ActionNames: ["s3:ListAllMyBuckets", "s3:DeleteBucket"],
 * });
 * const decisions = EvaluationResults?.map((r) => r.EvalDecision);
 * ```
 */
export interface SimulateCustomPolicy extends Binding.Service<
  SimulateCustomPolicy,
  "AWS.IAM.SimulateCustomPolicy",
  () => Effect.Effect<
    (
      request: iam.SimulateCustomPolicyRequest,
    ) => Effect.Effect<
      iam.SimulatePolicyResponse,
      iam.SimulateCustomPolicyError
    >
  >
> {}
export const SimulateCustomPolicy = Binding.Service<SimulateCustomPolicy>(
  "AWS.IAM.SimulateCustomPolicy",
);

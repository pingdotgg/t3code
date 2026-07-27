import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:SimulatePrincipalPolicy` — evaluate how the
 * policies attached to an existing IAM user, group, or role decide a list of
 * actions. The "can principal X do Y?" primitive behind access-review
 * dashboards and pre-flight permission checks.
 *
 * The principal (`PolicySourceArn`) is chosen per request — audit tooling
 * typically iterates entities discovered at runtime — so the binding takes no
 * arguments and grants `iam:SimulatePrincipalPolicy` on `*`. Provide the
 * implementation with `Effect.provide(AWS.IAM.SimulatePrincipalPolicyHttp)`.
 *
 * @binding
 * @section Simulating Policies
 * @example Check What a Role May Do
 * ```typescript
 * // init
 * const simulatePrincipalPolicy = yield* IAM.SimulatePrincipalPolicy();
 *
 * // runtime
 * const { EvaluationResults } = yield* simulatePrincipalPolicy({
 *   PolicySourceArn: roleArn,
 *   ActionNames: ["s3:GetObject", "iam:DeleteRole"],
 * });
 * const denied = EvaluationResults?.filter(
 *   (r) => r.EvalDecision !== "allowed",
 * );
 * ```
 */
export interface SimulatePrincipalPolicy extends Binding.Service<
  SimulatePrincipalPolicy,
  "AWS.IAM.SimulatePrincipalPolicy",
  () => Effect.Effect<
    (
      request: iam.SimulatePrincipalPolicyRequest,
    ) => Effect.Effect<
      iam.SimulatePolicyResponse,
      iam.SimulatePrincipalPolicyError
    >
  >
> {}
export const SimulatePrincipalPolicy = Binding.Service<SimulatePrincipalPolicy>(
  "AWS.IAM.SimulatePrincipalPolicy",
);

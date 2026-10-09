import type * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";

export interface EvaluateGkePolicyRequest extends Omit<
  binaryauthorization.EvaluateGkePolicyRequest,
  never
> {}

/**
 * Runtime binding for Binary Authorization
 * `platforms.gke.policies.evaluate`.
 *
 * Bind this operation to a {@link PlatformsPolicy} in a Function/Action
 * init phase. Provide {@link EvaluateGkePolicyHttp}.
 *
 * ### Evaluating a GKE Policy
 * **Example:** Evaluate a Pod against the bound policy
 * ```typescript
 * const evaluate = yield* GCP.BinaryAuthorization.EvaluateGkePolicy(policy);
 * const result = yield* evaluate({
 *   resource: {
 *     apiVersion: "v1",
 *     kind: "Pod",
 *     metadata: { name: "web", namespace: "default" },
 *     spec: { containers: [{ name: "nginx", image: "nginx" }] },
 *   },
 * });
 * ```
 *
 * @binding
 * @category BinaryAuthorization
 */
export interface EvaluateGkePolicy extends Binding.Service<
  EvaluateGkePolicy,
  "GCP.BinaryAuthorization.EvaluateGkePolicy",
  (
    policy: PlatformsPolicy,
  ) => Effect.Effect<
    (
      request: EvaluateGkePolicyRequest,
    ) => Effect.Effect<
      binaryauthorization.EvaluateGkePolicyResponse,
      binaryauthorization.EvaluateProjectsPlatformsGkePoliciesError,
      RuntimeContext
    >
  >
> {}

export const EvaluateGkePolicy = Binding.Service<EvaluateGkePolicy>(
  "GCP.BinaryAuthorization.EvaluateGkePolicy",
);

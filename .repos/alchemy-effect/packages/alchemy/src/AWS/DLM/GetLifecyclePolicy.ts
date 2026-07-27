import type * as dlm from "@distilled.cloud/aws/dlm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LifecyclePolicy } from "./LifecyclePolicy.ts";

/**
 * Runtime binding for `dlm:GetLifecyclePolicy`.
 *
 * Reads the bound {@link LifecyclePolicy}'s full detail — state (including
 * the observed-only `ERROR`), status message, execution role, and the
 * complete policy document — so an ops function can audit backup coverage
 * or alert on a policy that stopped running. The policy id is injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.DLM.GetLifecyclePolicyHttp)`.
 * @binding
 * @section Monitoring Lifecycle Policies
 * @example Check A Policy's State
 * ```typescript
 * // init — bind the operation to the lifecycle policy
 * const getLifecyclePolicy = yield* AWS.DLM.GetLifecyclePolicy(policy);
 *
 * // runtime
 * const { Policy } = yield* getLifecyclePolicy();
 * if (Policy?.State === "ERROR") {
 *   yield* Effect.logError(`DLM policy failed: ${Policy.StatusMessage}`);
 * }
 * ```
 */
export interface GetLifecyclePolicy extends Binding.Service<
  GetLifecyclePolicy,
  "AWS.DLM.GetLifecyclePolicy",
  (
    policy: LifecyclePolicy,
  ) => Effect.Effect<
    () => Effect.Effect<
      dlm.GetLifecyclePolicyResponse,
      dlm.GetLifecyclePolicyError
    >
  >
> {}
export const GetLifecyclePolicy = Binding.Service<GetLifecyclePolicy>(
  "AWS.DLM.GetLifecyclePolicy",
);
